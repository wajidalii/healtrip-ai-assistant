/**
 * The OpenAI credential mode (docs/DECISIONS.md ADR-9): the adapter must give
 * the loop exactly what the Anthropic SDK would, so these tests drive the real
 * `runTurn` through the adapter over a scripted Responses API and check both
 * directions of the translation, the persisted history, and error mapping.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Response, ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/shared/contracts";
import { createOpenAIAdapter, toBetaMessage, toResponsesParams, type OpenAIResponsesClient } from "@/server/agent/openai";
import { runTurn } from "@/server/agent/run-turn";
import { TOOL_DEFINITIONS } from "@/server/agent/tools";
import { createMemoryRepositories } from "@/server/repositories/memory";

// ---------------------------------------------------------------------------
// Scripted Responses API
// ---------------------------------------------------------------------------

type Scripted = { response: Response } | { throws: unknown };

const baseResponse = (output: Response["output"], extra: Partial<Response> = {}): Response =>
  ({
    id: "resp_1",
    object: "response",
    created_at: 0,
    model: "gpt-test",
    output,
    status: "completed",
    incomplete_details: null,
    error: null,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    temperature: null,
    top_p: null,
    instructions: null,
    metadata: null,
    output_text: "",
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 10 },
    },
    ...extra,
  }) as Response;

const textItem = (text: string): Response["output"][number] => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

const callItem = (name: string, args: string, callId = "call_1"): Response["output"][number] => ({
  id: "fc_1",
  type: "function_call",
  call_id: callId,
  name,
  arguments: args,
  status: "completed",
});

const reasoningItem = (id = "rs_1", encrypted: string | null = "ENC"): Response["output"][number] => ({
  id,
  type: "reasoning",
  summary: [],
  encrypted_content: encrypted,
});

function scriptedOpenAI(script: Scripted[]): { client: OpenAIResponsesClient; calls: ResponseCreateParamsStreaming[] } {
  const calls: ResponseCreateParamsStreaming[] = [];
  const queue = [...script];
  return {
    calls,
    client: {
      responses: {
        stream: (params) => {
          calls.push(structuredClone(params));
          const turn = queue.shift();
          if (!turn) throw new Error("scripted OpenAI client: no more turns");
          if ("throws" in turn) {
            return {
              async *[Symbol.asyncIterator]() {
                throw turn.throws;
              },
              finalResponse: () => Promise.reject(turn.throws),
            };
          }
          const events: ResponseStreamEvent[] = turn.response.output.flatMap((item, output_index) =>
            item.type === "message"
              ? item.content.flatMap((part) =>
                  part.type === "output_text"
                    ? [
                        {
                          type: "response.output_text.delta",
                          delta: part.text,
                          item_id: item.id,
                          output_index,
                          content_index: 0,
                          sequence_number: 0,
                          logprobs: [],
                        } satisfies ResponseStreamEvent,
                      ]
                    : [],
                )
              : [],
          );
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalResponse: () => Promise.resolve(turn.response),
          };
        },
      },
    },
  };
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

describe("toResponsesParams", () => {
  it("maps system, effort, max_tokens and tools, and keeps the conversation stateless", () => {
    const params = toResponsesParams({
      model: "gpt-x",
      max_tokens: 8192,
      system: [{ type: "text", text: "You are HealTrip.", cache_control: { type: "ephemeral" } }],
      tools: [...TOOL_DEFINITIONS],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
    });
    expect(params).toMatchObject({
      model: "gpt-x",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      instructions: "You are HealTrip.",
      max_output_tokens: 8192,
      reasoning: { effort: "low" },
      input: [{ role: "user", content: "hi" }],
    });
    expect(params.tools).toHaveLength(TOOL_DEFINITIONS.length);
    expect(params.tools?.[0]).toMatchObject({ type: "function", name: TOOL_DEFINITIONS[0].name, strict: false });
    expect((params.tools?.[0] as { parameters: unknown }).parameters).toEqual(TOOL_DEFINITIONS[0].input_schema);
    expect(JSON.stringify(params)).not.toContain("cache_control");
    expect(JSON.stringify(params)).not.toContain("fallback");
  });

  it("replays tool_use, tool_result and stored reasoning as Responses items in order", () => {
    const params = toResponsesParams({
      model: "gpt-x",
      max_tokens: 10,
      messages: [
        { role: "user", content: [{ type: "text", text: "find a cardiologist" }] },
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: JSON.stringify({ id: "rs_1", encrypted_content: "ENC" }) },
            { type: "tool_use", id: "call_1", name: "search_providers", input: { specialty: "cardiology" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"providers":[]}' }] },
        // An Anthropic-mode `thinking` block cannot be replayed to OpenAI and is dropped, not sent.
        { role: "assistant", content: [{ type: "thinking", thinking: "...", signature: "sig" }, { type: "text", text: "None found." }] },
      ],
    });
    expect(params.input).toEqual([
      { role: "user", content: "find a cardiologist" },
      { type: "reasoning", id: "rs_1", encrypted_content: "ENC", summary: [] },
      { type: "function_call", call_id: "call_1", name: "search_providers", arguments: '{"specialty":"cardiology"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"providers":[]}' },
      { role: "assistant", content: "None found." },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

describe("toBetaMessage", () => {
  it("turns output items into content blocks with stop_reason and usage", () => {
    const message = toBetaMessage(
      baseResponse([reasoningItem(), textItem("Searching."), callItem("search_providers", '{"specialty":"cardiology"}')]),
    );
    expect(message.content).toEqual([
      { type: "redacted_thinking", data: JSON.stringify({ id: "rs_1", encrypted_content: "ENC" }) },
      { type: "text", text: "Searching.", citations: null },
      { type: "tool_use", id: "call_1", name: "search_providers", input: { specialty: "cardiology" } },
    ]);
    expect(message.stop_reason).toBe("tool_use");
    expect(message.usage).toMatchObject({ input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100 });
  });

  it("maps end_turn, max_tokens and refusal", () => {
    expect(toBetaMessage(baseResponse([textItem("Done.")])).stop_reason).toBe("end_turn");
    expect(
      toBetaMessage(baseResponse([textItem("Partial")], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).stop_reason,
    ).toBe("max_tokens");
    expect(
      toBetaMessage(baseResponse([], { status: "incomplete", incomplete_details: { reason: "content_filter" } })).stop_reason,
    ).toBe("refusal");
    const refusal = toBetaMessage(
      baseResponse([
        { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] },
      ]),
    );
    expect(refusal.stop_reason).toBe("refusal");
    expect(refusal.content).toEqual([]);
  });

  it("raises the SDK's tool-JSON error class on unparseable arguments, so the loop re-issues the step", () => {
    expect(() => toBetaMessage(baseResponse([callItem("search_providers", "{not json")]))).toThrow(Anthropic.AnthropicError);
    try {
      toBetaMessage(baseResponse([callItem("search_providers", "{not json")]));
    } catch (err) {
      expect(err).not.toBeInstanceOf(Anthropic.APIError);
    }
  });
});

// ---------------------------------------------------------------------------
// Through the real loop
// ---------------------------------------------------------------------------

describe("runTurn over the OpenAI adapter", () => {
  async function turn(script: Scripted[], userText = "I need a cardiologist in Riyadh") {
    const repos = createMemoryRepositories();
    const conversation = await repos.conversations.create("en");
    const openai = scriptedOpenAI(script);
    const events = await collect(
      runTurn({
        conversationId: conversation.id,
        userText,
        locale: "en",
        deps: { repos, client: createOpenAIAdapter(openai.client), model: "gpt-test", effort: "low", maxSteps: 4, useServerFallbacks: false },
      }),
    );
    return { repos, conversation, openai, events };
  }

  it("streams text, runs a grounded tool, replays reasoning + call + output on the next step, and ends with done", async () => {
    const { repos, conversation, openai, events } = await turn([
      { response: baseResponse([reasoningItem(), callItem("search_providers", '{"specialty":"cardiology","city":"Riyadh"}')]) },
      { response: baseResponse([reasoningItem("rs_2"), textItem("Here are options.")], { id: "resp_2" }) },
    ]);

    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text_delta", "done"]);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ name: "search_providers", ok: true });
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 120, cacheReadInputTokens: 100 } });

    // Second request carries the first step back in Responses form, in order.
    expect(openai.calls).toHaveLength(2);
    const replay = openai.calls[1].input as unknown[];
    expect(replay[0]).toEqual({ role: "user", content: "I need a cardiologist in Riyadh" });
    expect(replay[1]).toEqual({ type: "reasoning", id: "rs_1", encrypted_content: "ENC", summary: [] });
    expect(replay[2]).toMatchObject({ type: "function_call", call_id: "call_1", name: "search_providers" });
    expect(replay[3]).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    expect(String((replay[3] as { output: string }).output)).toContain("\"results\"");

    // Persisted history keeps the loop's own shape, so reload and projection are unchanged.
    const history = await repos.conversations.listMessages(conversation.id);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history[1].content.map((b) => (b as { type: string }).type)).toEqual(["redacted_thinking", "tool_use"]);
    expect(history[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1" });
  });

  it("maps OpenAI SDK errors onto the loop's user-safe error events", async () => {
    const auth = new OpenAI.AuthenticationError(401, { error: { message: "bad key" } }, "bad key", new Headers());
    const { events } = await turn([{ throws: auth }]);
    expect(events).toEqual([{ type: "error", code: "upstream_error", message: "AI service is not configured", retryable: false }]);

    const rate = new OpenAI.RateLimitError(429, { error: { message: "slow down" } }, "slow down", new Headers());
    expect((await turn([{ throws: rate }])).events[0]).toMatchObject({ code: "upstream_error", retryable: true });

    // Seen live: an account with no credits answers 429 with code insufficient_quota. Not a rate limit.
    const quota = new OpenAI.RateLimitError(
      429,
      { error: { message: "You have no credits remaining.", code: "insufficient_quota", type: "insufficient_quota" } },
      "429 You have no credits remaining.",
      new Headers(),
    );
    expect((await turn([{ throws: quota }])).events[0]).toEqual({
      type: "error",
      code: "upstream_error",
      message: "AI service has no remaining credits; the operator must top up the account",
      retryable: false,
    });

    const conn = new OpenAI.APIConnectionError({ message: "ECONNRESET" });
    expect((await turn([{ throws: conn }])).events[0]).toMatchObject({ code: "upstream_error", retryable: true });

    const server = new OpenAI.InternalServerError(503, { error: { message: "down" } }, "down", new Headers());
    expect((await turn([{ throws: server }])).events[0]).toMatchObject({ code: "upstream_error", retryable: true });

    const abort = new OpenAI.APIUserAbortError();
    expect((await turn([{ throws: abort }])).events[0]).toMatchObject({ code: "internal_error", message: "Request was cancelled" });
  });

  it("never runs a tool when the reply was cut short", async () => {
    const { events, repos, conversation } = await turn([
      {
        response: baseResponse([callItem("search_providers", '{"specialty":"cardiology"}')], {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      },
    ]);
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "max_tokens" })]);
    expect(await repos.conversations.listToolCalls(conversation.id)).toEqual([]);
    // The unanswered call is settled so the stored history stays replayable.
    const history = await repos.conversations.listMessages(conversation.id);
    expect(history.at(-1)?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1", is_error: true });
  });
});
