import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Locale } from "@/shared/contracts";
import { createMemoryRepositories } from "@/server/repositories/memory";
import type { Repositories } from "@/server/repositories/types";
import { runTurn } from "@/server/agent/run-turn";
import { createFakeClaude, textTurn, toolTurn, toolUseBlock, type ScriptedTurn } from "./helpers/fake-claude";

const CARDIOLOGIST_ISTANBUL = "41d456cd-2271-48aa-a326-fbf9818757b3"; // Dr. Elif Kaya
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const RATIONALE =
  "Your symptoms suggest you should see a cardiologist within 24 hours. Dr. Elif Kaya " +
  `(${CARDIOLOGIST_ISTANBUL}) is available in Istanbul. This is guidance, not medical advice.`;

const ASSESS_INPUT = { symptoms: ["chest pain"], red_flags: [], severity_1_to_10: 8, age: 45 };
const SEARCH_INPUT = { specialty: "cardiology", city: "Istanbul" };
const recommendInput = (providerIds: string[]) => ({
  next_step: "urgent_care_24h",
  urgency: "urgent",
  specialty: "cardiology",
  provider_ids: providerIds,
  rationale_for_patient: RATIONALE,
  questions_remaining: [],
});

type Collected = { events: AgentEvent[]; terminal: AgentEvent };

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<Collected> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  const terminal = events.at(-1);
  if (!terminal) throw new Error("no events");
  return { events, terminal };
}

const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

describe("runTurn", () => {
  let repos: Repositories;
  let conversationId: string;

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    repos = createMemoryRepositories();
    conversationId = (await repos.conversations.create("en")).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function run(script: readonly ScriptedTurn[], overrides: { maxSteps?: number; locale?: Locale; userText?: string } = {}) {
    const fake = createFakeClaude(script);
    const gen = runTurn({
      conversationId,
      userText: overrides.userText ?? "I have chest pain, what should I do?",
      locale: overrides.locale ?? "en",
      deps: {
        repos,
        client: fake.client,
        model: "claude-test",
        effort: "low",
        maxSteps: overrides.maxSteps ?? 6,
      },
    });
    return { fake, result: collect(gen) };
  }

  it("streams a clarifying question, ends with done and persists two messages", async () => {
    const { result } = run([textTurn("How long have you had the pain, and does it spread to your arm?")]);
    const { events, terminal } = await result;

    expect(ofType(events, "text_delta").map((e) => e.text).join("")).toContain("How long");
    expect(terminal).toMatchObject({ type: "done", stopReason: "end_turn" });
    expect(ofType(events, "recommendation")).toHaveLength(0);
    expect(ofType(events, "error")).toHaveLength(0);

    const history = await repos.conversations.listMessages(conversationId);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history[0].content).toEqual([{ type: "text", text: "I have chest pain, what should I do?" }]);
    expect(history[1].content).toMatchObject([{ type: "text", text: expect.stringContaining("How long") }]);
    expect(await repos.conversations.listRecommendations(conversationId)).toEqual([]);
  });

  it("runs the tool path and emits a hydrated, persisted recommendation", async () => {
    const assess = toolUseBlock("assess_urgency", ASSESS_INPUT, "toolu_assess");
    const search = toolUseBlock("search_providers", SEARCH_INPUT, "toolu_search");
    const recommend = toolUseBlock("recommend_next_step", recommendInput([CARDIOLOGIST_ISTANBUL]), "toolu_rec");
    const { fake, result } = run([
      toolTurn([assess, search], "Let me check that."),
      toolTurn([recommend]),
      textTurn("I have recorded a recommendation above."),
    ]);
    const { events, terminal } = await result;

    expect(terminal.type).toBe("done");
    expect(ofType(events, "tool_call").map((e) => e.name)).toEqual([
      "assess_urgency",
      "search_providers",
      "recommend_next_step",
    ]);
    const results = ofType(events, "tool_result");
    expect(results.map((e) => [e.name, e.ok, e.summary])).toEqual([
      ["assess_urgency", true, "urgent - cardiology"],
      ["search_providers", true, expect.stringMatching(/providers? found$/)],
      ["recommend_next_step", true, "Recommendation saved"],
    ]);

    const [recommendation] = ofType(events, "recommendation");
    expect(recommendation.recommendation).toMatchObject({ nextStep: "urgent_care_24h", urgency: "urgent" });
    expect(recommendation.recommendation.providers.map((p) => p.id)).toEqual([CARDIOLOGIST_ISTANBUL]);
    expect(recommendation.recommendation.providers[0].nameEn).toBe("Dr. Elif Kaya");
    const stored = await repos.conversations.listRecommendations(conversationId);
    expect(stored.map((r) => r.id)).toEqual([recommendation.recommendation.id]);

    // The order of the recommendation event relative to its tool_result matters for the UI.
    const recIndex = events.indexOf(recommendation);
    const recResultIndex = events.findIndex((e) => e.type === "tool_result" && e.id === "toolu_rec");
    expect(recIndex).toBe(recResultIndex + 1);

    // Both tool results of step 1 are sent back in one user message, in order.
    const secondCall = fake.calls[1];
    const toolResultMessage = secondCall.messages.at(-1);
    expect(toolResultMessage?.role).toBe("user");
    const blocks = toolResultMessage?.content;
    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) return;
    expect(blocks.map((b) => (b.type === "tool_result" ? [b.tool_use_id, b.is_error] : null))).toEqual([
      ["toolu_assess", false],
      ["toolu_search", false],
    ]);

    // Persisted history is user, assistant, user(tool_results), assistant, user(tool_results), assistant.
    const history = await repos.conversations.listMessages(conversationId);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(history[1].content).toEqual(fake.calls[1].messages[1].content);

    const audit = await repos.conversations.listToolCalls(conversationId);
    expect(audit.map((c) => [c.toolName, c.isError])).toEqual([
      ["assess_urgency", false],
      ["search_providers", false],
      ["recommend_next_step", false],
    ]);
    expect(audit.every((c) => c.latencyMs >= 0)).toBe(true);
  });

  it("rejects an ungrounded provider id, lets the model correct itself and then saves", async () => {
    const { fake, result } = run([
      toolTurn([toolUseBlock("search_providers", SEARCH_INPUT)]),
      toolTurn([toolUseBlock("recommend_next_step", recommendInput([UNKNOWN_ID]), "toolu_bad")]),
      toolTurn([toolUseBlock("recommend_next_step", recommendInput([CARDIOLOGIST_ISTANBUL]), "toolu_good")]),
      textTurn("Done."),
    ]);
    const { events, terminal } = await result;

    expect(terminal.type).toBe("done");
    const results = ofType(events, "tool_result").filter((e) => e.name === "recommend_next_step");
    expect(results.map((e) => e.ok)).toEqual([false, true]);
    expect(results[0].summary).toBe("Rejected: unknown provider ids");

    // The error text (with allowed ids) reaches the model as an is_error tool_result.
    const correctionCall = fake.calls[2];
    const last = correctionCall.messages.at(-1)?.content;
    if (!Array.isArray(last)) throw new Error("expected tool_result blocks");
    const block = last[0];
    expect(block.type).toBe("tool_result");
    if (block.type !== "tool_result") return;
    expect(block.is_error).toBe(true);
    expect(block.content).toContain(UNKNOWN_ID);
    expect(block.content).toContain(`Allowed ids: [${CARDIOLOGIST_ISTANBUL}`);

    expect(ofType(events, "recommendation")).toHaveLength(1);
    expect(await repos.conversations.listRecommendations(conversationId)).toHaveLength(1);
  });

  it("stops with step_limit when the model keeps calling tools", async () => {
    const endless = Array.from({ length: 5 }, () =>
      toolTurn([toolUseBlock("assess_urgency", ASSESS_INPUT)]),
    );
    const { fake, result } = run(endless, { maxSteps: 3 });
    const { terminal } = await result;
    expect(terminal).toMatchObject({ type: "error", code: "step_limit", retryable: false });
    expect(fake.calls).toHaveLength(3);
  });

  it("maps a refusal to a non-retryable refusal error and persists the content", async () => {
    const { result } = run([{ content: [], stopReason: "refusal" }]);
    const { events, terminal } = await result;
    expect(terminal).toMatchObject({ type: "error", code: "refusal", retryable: false });
    expect(ofType(events, "error")).toHaveLength(1);
    const history = await repos.conversations.listMessages(conversationId);
    expect(history).toHaveLength(2);
  });

  it("maps max_tokens with pending tool_use to a max_tokens error without running tools", async () => {
    const { result } = run([
      { content: [toolUseBlock("search_providers", SEARCH_INPUT)], stopReason: "max_tokens" },
    ]);
    const { events, terminal } = await result;
    expect(terminal).toMatchObject({ type: "error", code: "max_tokens" });
    expect(ofType(events, "tool_call")).toHaveLength(0);
    expect(await repos.conversations.listToolCalls(conversationId)).toEqual([]);
  });

  it("maps RateLimitError to a retryable upstream_error", async () => {
    const err = new Anthropic.RateLimitError(429, { type: "rate_limit_error" }, "rate limited", new Headers());
    const { result } = run([{ throws: err }]);
    const { events, terminal } = await result;
    expect(terminal).toMatchObject({ type: "error", code: "upstream_error", retryable: true });
    expect(events).toHaveLength(1);
  });

  it("maps AuthenticationError and generic 4xx/5xx without leaking details", async () => {
    const auth = new Anthropic.AuthenticationError(401, { type: "authentication_error" }, "bad key sk-xyz", new Headers());
    const { terminal: t1 } = await run([{ throws: auth }]).result;
    expect(t1).toMatchObject({ type: "error", code: "upstream_error", retryable: false, message: "AI service is not configured" });

    const server = new Anthropic.InternalServerError(503, { type: "overloaded_error" }, "overloaded", new Headers());
    const { terminal: t2 } = await run([{ throws: server }]).result;
    expect(t2).toMatchObject({ type: "error", code: "upstream_error", retryable: true });

    const bad = new Anthropic.BadRequestError(400, { type: "invalid_request_error" }, "bad", new Headers());
    const { terminal: t3 } = await run([{ throws: bad }]).result;
    expect(t3).toMatchObject({ type: "error", code: "upstream_error", retryable: false });

    const { terminal: t4 } = await run([{ throws: new Error("boom") }]).result;
    expect(t4).toMatchObject({ type: "error", code: "internal_error", retryable: false });
    if (t4.type === "error") expect(t4.message).not.toContain("boom");
  });

  it("re-issues the request once when the SDK cannot parse tool JSON", async () => {
    const jsonError = new Anthropic.AnthropicError("Unable to parse tool parameter JSON from model.");
    const { fake, result } = run([{ throws: jsonError }, textTurn("Recovered.")]);
    const { terminal } = await result;
    expect(terminal.type).toBe("done");
    expect(fake.calls).toHaveLength(2);

    const { fake: fake2, result: result2 } = run([{ throws: jsonError }, { throws: jsonError }]);
    expect((await result2).terminal).toMatchObject({ type: "error", code: "internal_error" });
    expect(fake2.calls).toHaveLength(2);
  });

  it("sends invalid tool input back as an is_error result and continues", async () => {
    const { fake, result } = run([
      toolTurn([toolUseBlock("search_providers", { city: "Istanbul" }, "toolu_invalid")]),
      textTurn("Sorry, let me ask you something first."),
    ]);
    const { events, terminal } = await result;
    expect(terminal.type).toBe("done");
    expect(ofType(events, "tool_result")[0]).toMatchObject({ ok: false, summary: "Invalid tool input" });

    const sent = fake.calls[1].messages.at(-1)?.content;
    if (!Array.isArray(sent) || sent[0].type !== "tool_result") throw new Error("expected tool_result");
    expect(sent[0].is_error).toBe(true);
    expect(sent[0].content).toContain("specialty");
    const audit = await repos.conversations.listToolCalls(conversationId);
    expect(audit[0].isError).toBe(true);
  });

  it("builds cache-friendly requests: cached static system block, volatile locale last, stable tools", async () => {
    const { fake, result } = run(
      [toolTurn([toolUseBlock("assess_urgency", ASSESS_INPUT)]), textTurn("ok")],
      { locale: "ar" },
    );
    await result;
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.model).toBe("claude-test");
      expect(call.max_tokens).toBe(4096);
      expect(call.output_config).toEqual({ effort: "low" });
      expect(call.betas).toEqual(["server-side-fallback-2026-07-01"]);
      expect(call.fallbacks).toBe("default");
      expect(call.tool_choice).toBeUndefined();
      const system = call.system;
      if (!Array.isArray(system)) throw new Error("expected system blocks");
      expect(system).toHaveLength(2);
      expect(system[0].cache_control).toEqual({ type: "ephemeral" });
      expect(system[0].text).toContain("recommend_next_step");
      expect(system[1].cache_control).toBeUndefined();
      expect(system[1].text).toContain("Arabic");
    }
    expect(fake.calls[0].system).toEqual(fake.calls[1].system);
    expect(fake.calls[0].tools).toEqual(fake.calls[1].tools);
    expect(fake.calls[0].tools?.map((t) => ("name" in t ? t.name : ""))).toEqual([
      "assess_urgency",
      "search_providers",
      "get_provider_details",
      "recommend_next_step",
    ]);
    // The history prefix is byte-identical between steps, so the cache can hit.
    expect(fake.calls[1].messages[0]).toEqual(fake.calls[0].messages[0]);
  });

  it("rebuilds grounding from persisted tool_calls on the next turn", async () => {
    const first = run([toolTurn([toolUseBlock("search_providers", SEARCH_INPUT)]), textTurn("Which one?")]);
    expect((await first.result).terminal.type).toBe("done");

    const second = run(
      [toolTurn([toolUseBlock("recommend_next_step", recommendInput([CARDIOLOGIST_ISTANBUL]))]), textTurn("Done.")],
      { userText: "The first one please." },
    );
    const { events, terminal } = await second.result;
    expect(terminal.type).toBe("done");
    expect(ofType(events, "tool_result")[0]).toMatchObject({ ok: true, summary: "Recommendation saved" });
    expect(ofType(events, "recommendation")).toHaveLength(1);

    // The second turn replays the full persisted history, including turn-one tool plumbing.
    expect(second.fake.calls[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  });

  it("emits internal_error for an unknown conversation", async () => {
    const fake = createFakeClaude([]);
    const { events } = await collect(
      runTurn({
        conversationId: UNKNOWN_ID,
        userText: "hi",
        locale: "en",
        deps: { repos, client: fake.client, model: "m", effort: "low", maxSteps: 2 },
      }),
    );
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "internal_error" })]);
    expect(fake.calls).toHaveLength(0);
  });

  it("stops before calling the model when the signal is already aborted", async () => {
    const fake = createFakeClaude([textTurn("never")]);
    const controller = new AbortController();
    controller.abort();
    const { events } = await collect(
      runTurn({
        conversationId,
        userText: "hi",
        locale: "en",
        deps: { repos, client: fake.client, model: "m", effort: "low", maxSteps: 2, signal: controller.signal },
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", code: "internal_error" });
    expect(fake.calls).toHaveLength(0);
  });
});
