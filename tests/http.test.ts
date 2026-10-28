import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentEvent, ApiErrorBody, Recommendation } from "@/shared/contracts";
import type { StoredConversation, StoredMessage, StoredToolCall } from "@/server/repositories/types";
import { AppError, badRequest, conflict, rateLimited, toErrorResponse } from "@/server/http/errors";
import { toConversationView } from "@/server/http/projection";
import { SlidingWindowRateLimiter, getClientIp } from "@/server/http/rate-limit";
import { parseConversationId, parseProviderSearchQuery, readJson } from "@/server/http/request";
import { createSseResponse, encodeEvent } from "@/server/http/sse";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type SseFrame = { event: string; data: AgentEvent };

/** Reads a whole SSE body and splits it into frames plus raw comment lines. */
async function readSse(res: Response): Promise<{ frames: SseFrame[]; comments: string[] }> {
  const text = await res.text();
  const frames: SseFrame[] = [];
  const comments: string[] = [];
  for (const block of text.split("\n\n").filter((b) => b.length > 0)) {
    if (block.startsWith(":")) {
      comments.push(block);
      continue;
    }
    const lines = block.split("\n");
    const event = lines.find((l) => l.startsWith("event: "))?.slice("event: ".length) ?? "message";
    const data = lines.find((l) => l.startsWith("data: "))?.slice("data: ".length) ?? "";
    frames.push({ event, data: JSON.parse(data) as AgentEvent });
  }
  return { frames, comments };
}

async function* events(...list: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of list) yield e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DONE: AgentEvent = {
  type: "done",
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 },
};

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

// ---------------------------------------------------------------------------
// sse.ts
// ---------------------------------------------------------------------------

describe("encodeEvent", () => {
  it("produces `event: <type>` and a JSON data line terminated by a blank line", () => {
    const encoded = encodeEvent({ type: "text_delta", text: "hi\nthere" });
    expect(encoded).toBe('event: text_delta\ndata: {"type":"text_delta","text":"hi\\nthere"}\n\n');
  });
});

describe("createSseResponse", () => {
  it("sets streaming headers", () => {
    const res = createSseResponse(events(DONE));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
  });

  it("forwards events in order and calls onFinish once", async () => {
    const onFinish = vi.fn();
    const res = createSseResponse(events({ type: "text_delta", text: "a" }, DONE), { onFinish });
    const { frames } = await readSse(res);
    expect(frames.map((f) => f.event)).toEqual(["text_delta", "done"]);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("appends an error event when the iterable ends without a terminal event", async () => {
    const onFinish = vi.fn(async () => undefined);
    const res = createSseResponse(events({ type: "text_delta", text: "partial" }), { onFinish });
    const { frames } = await readSse(res);
    expect(frames.at(-1)?.event).toBe("error");
    expect(frames.at(-1)?.data).toMatchObject({ type: "error", code: "internal_error", retryable: true });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("stops after the first terminal event even if the iterable keeps going", async () => {
    let finallyRan = false;
    async function* leaky(): AsyncGenerator<AgentEvent> {
      try {
        yield DONE;
        yield { type: "text_delta", text: "should not be sent" };
      } finally {
        finallyRan = true;
      }
    }
    const { frames } = await readSse(createSseResponse(leaky()));
    expect(frames).toHaveLength(1);
    expect(finallyRan).toBe(true);
  });

  it("turns a thrown AppError into a terminal error event with its message", async () => {
    async function* failing(): AsyncGenerator<AgentEvent> {
      yield { type: "conversation", conversationId: "c1" };
      throw new AppError("upstream_error", 502, "not configured");
    }
    const { frames } = await readSse(createSseResponse(failing()));
    expect(frames.map((f) => f.event)).toEqual(["conversation", "error"]);
    expect(frames[1].data).toMatchObject({ code: "upstream_error", message: "not configured", retryable: false });
  });

  it("masks unknown thrown errors and still calls onFinish", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onFinish = vi.fn();
    async function* failing(): AsyncGenerator<AgentEvent> {
      yield { type: "text_delta", text: "x" };
      throw new Error("secret stack");
    }
    const { frames } = await readSse(createSseResponse(failing(), { onFinish }));
    expect(frames.at(-1)?.data).toMatchObject({ type: "error", code: "internal_error" });
    expect(JSON.stringify(frames)).not.toContain("secret stack");
    expect(onFinish).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("emits heartbeat comments while the agent is idle", async () => {
    async function* slow(): AsyncGenerator<AgentEvent> {
      await sleep(40);
      yield DONE;
    }
    const { comments, frames } = await readSse(createSseResponse(slow(), { heartbeatMs: 5 }));
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0]).toBe(": heartbeat");
    expect(frames.map((f) => f.event)).toEqual(["done"]);
  });

  it("releases the lock and winds the generator down when the client cancels", async () => {
    const onFinish = vi.fn();
    let finallyRan = false;
    async function* endless(): AsyncGenerator<AgentEvent> {
      try {
        let i = 0;
        while (true) {
          await sleep(1);
          yield { type: "text_delta", text: String(i++) };
        }
      } finally {
        finallyRan = true;
      }
    }
    const res = createSseResponse(endless(), { onFinish, heartbeatMs: 1000 });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    expect(finallyRan).toBe(true);
  });

  it("stops when the request signal aborts", async () => {
    const controller = new AbortController();
    const onFinish = vi.fn();
    async function* endless(): AsyncGenerator<AgentEvent> {
      while (true) {
        await sleep(1);
        yield { type: "text_delta", text: "tick" };
      }
    }
    const res = createSseResponse(endless(), { signal: controller.signal, onFinish, heartbeatMs: 1000 });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
  });
});

// ---------------------------------------------------------------------------
// rate-limit.ts
// ---------------------------------------------------------------------------

describe("SlidingWindowRateLimiter", () => {
  it("allows `limit` hits per window, then rejects with a retry hint, then recovers", () => {
    let now = 1_000;
    const limiter = new SlidingWindowRateLimiter(3, 1_000, () => now);

    expect(limiter.check("ip").remaining).toBe(2);
    now += 100;
    expect(limiter.check("ip").remaining).toBe(1);
    now += 100;
    expect(limiter.check("ip").remaining).toBe(0);

    now += 100;
    const denied = limiter.check("ip");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(700); // first hit at 1000 leaves the window at 2000

    now = 2_001; // first hit expired
    expect(limiter.check("ip")).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.check("ip").allowed).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = new SlidingWindowRateLimiter(1, 1_000, () => 0);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.size).toBe(2);
  });

  it("rejects a non-positive configuration", () => {
    expect(() => new SlidingWindowRateLimiter(0, 1_000)).toThrow();
  });
});

describe("getClientIp", () => {
  const withHeaders = (headers: Record<string, string>) => new Request("http://localhost/", { headers });

  it("prefers the first x-forwarded-for address", () => {
    expect(getClientIp(withHeaders({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1", "x-real-ip": "10.0.0.2" }))).toBe(
      "203.0.113.9",
    );
  });

  it("falls back to x-real-ip, then to 'unknown'", () => {
    expect(getClientIp(withHeaders({ "x-real-ip": "10.0.0.2" }))).toBe("10.0.0.2");
    expect(getClientIp(withHeaders({}))).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// request.ts
// ---------------------------------------------------------------------------

describe("readJson", () => {
  const expectAppError = async (promise: Promise<unknown>, code: string, status: number) => {
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code, status });
  };

  it("parses a small JSON body", async () => {
    await expect(readJson(jsonRequest('{"locale":"ar"}'))).resolves.toEqual({ locale: "ar" });
  });

  it("rejects a declared Content-Length above the cap before reading", async () => {
    await expectAppError(readJson(jsonRequest("{}", { "content-length": "999999" }), 1024), "payload_too_large", 413);
  });

  it("rejects an actual body above the cap even without Content-Length", async () => {
    const big = JSON.stringify({ content: "x".repeat(20_000) });
    await expectAppError(readJson(jsonRequest(big)), "payload_too_large", 413);
  });

  it("rejects malformed and empty bodies as validation errors", async () => {
    await expectAppError(readJson(jsonRequest("{not json")), "validation_error", 400);
    await expectAppError(readJson(new Request("http://localhost/", { method: "POST" })), "validation_error", 400);
  });
});

describe("parseConversationId", () => {
  it("accepts only v4 UUIDs (the ids the server generates) and reports anything else as not found", () => {
    expect(parseConversationId(" 11111111-1111-4111-8111-111111111111 ")).toBe("11111111-1111-4111-8111-111111111111");
    expect(parseConversationId("11111111-1111-4111-8111-111111111111".toUpperCase())).toBe("11111111-1111-4111-8111-111111111111");
    for (const bad of ["11111111-1111-1111-8111-111111111111", "11111111-1111-4111-c111-111111111111", "abc", ""]) {
      expect(() => parseConversationId(bad)).toThrow(AppError);
    }
  });
});

describe("parseProviderSearchQuery", () => {
  it("coerces booleans and limit from query strings", () => {
    const query = parseProviderSearchQuery(
      new URLSearchParams("specialty=cardiology&city=Istanbul&emergencyCapable=true&telemedicine=false&limit=5"),
    );
    expect(query).toEqual({
      specialty: "cardiology",
      city: "Istanbul",
      emergencyCapable: true,
      telemedicine: false,
      limit: 5,
    });
  });

  it("applies the default limit and reports invalid values through zod", () => {
    expect(parseProviderSearchQuery(new URLSearchParams("specialty=neurology")).limit).toBe(10);
    expect(() => parseProviderSearchQuery(new URLSearchParams("specialty=neurology&limit=50"))).toThrow(z.ZodError);
    expect(() => parseProviderSearchQuery(new URLSearchParams("specialty=neurology&emergencyCapable=yes"))).toThrow(
      z.ZodError,
    );
    expect(() => parseProviderSearchQuery(new URLSearchParams("city=Istanbul"))).toThrow(z.ZodError);
  });
});

// ---------------------------------------------------------------------------
// errors.ts
// ---------------------------------------------------------------------------

describe("toErrorResponse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serialises AppError with its status, headers and details", async () => {
    const res = toErrorResponse(rateLimited(2.2));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3");
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.details).toEqual({ retryAfterSeconds: 2.2 });

    expect(toErrorResponse(conflict()).status).toBe(409);
    const bad = toErrorResponse(badRequest("nope"));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiErrorBody).error).toEqual({ code: "validation_error", message: "nope" });
  });

  it("maps ZodError to validation_error with flattened issues", async () => {
    const err = z.object({ content: z.string().min(1) }).safeParse({ content: "" }).error!;
    const res = toErrorResponse(err);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toMatch(/^content: /);
    expect(body.error.details).toMatchObject({ fieldErrors: { content: [expect.any(String)] } });
  });

  it("masks unknown errors and logs them", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = toErrorResponse(new Error("connection string postgres://user:pw@host"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiErrorBody;
    expect(body).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// projection.ts
// ---------------------------------------------------------------------------

describe("toConversationView", () => {
  const conversation: StoredConversation = {
    id: "11111111-1111-4111-8111-111111111111",
    locale: "en",
    status: "open",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:10Z"),
  };

  const recommendation: Recommendation = {
    id: "22222222-2222-4222-8222-222222222222",
    nextStep: "urgent_care_24h",
    urgency: "urgent",
    specialty: "cardiology",
    rationale: "Same-day cardiology review.",
    providers: [],
    questionsRemaining: [],
    createdAt: "2026-01-01T00:00:06Z",
  };

  let seq = 0;
  const msg = (role: "user" | "assistant", content: unknown[], at: string): StoredMessage => ({
    id: `m${seq}`,
    conversationId: conversation.id,
    seq: seq++,
    role,
    content,
    createdAt: new Date(at),
  });

  const call = (toolUseId: string, toolName: string, output: unknown, isError = false): StoredToolCall => ({
    id: `tc-${toolUseId}`,
    conversationId: conversation.id,
    toolUseId,
    toolName,
    input: {},
    output,
    isError,
    latencyMs: 5,
    createdAt: new Date("2026-01-01T00:00:05Z"),
  });

  const messages = [
    msg("user", [{ type: "text", text: "I have chest pain" }], "2026-01-01T00:00:01Z"),
    msg(
      "assistant",
      [
        { type: "thinking", thinking: "…", signature: "sig" },
        { type: "text", text: "Let me check how urgent this is." },
        { type: "tool_use", id: "tu1", name: "assess_urgency", input: { symptoms: ["chest pain"] } },
      ],
      "2026-01-01T00:00:02Z",
    ),
    msg("user", [{ type: "tool_result", tool_use_id: "tu1", content: "{}" }], "2026-01-01T00:00:03Z"),
    msg(
      "assistant",
      [
        { type: "tool_use", id: "tu2", name: "search_providers", input: {} },
        { type: "tool_use", id: "tu3", name: "recommend_next_step", input: {} },
      ],
      "2026-01-01T00:00:04Z",
    ),
    msg(
      "user",
      [
        { type: "tool_result", tool_use_id: "tu2", content: "{}" },
        { type: "tool_result", tool_use_id: "tu3", content: "{}" },
      ],
      "2026-01-01T00:00:07Z",
    ),
    msg("assistant", [{ type: "text", text: "You should be seen today." }], "2026-01-01T00:00:08Z"),
    msg("user", [{ type: "text", text: "Thanks" }], "2026-01-01T00:00:20Z"),
    msg("assistant", [{ type: "text", text: "Take care." }], "2026-01-01T00:00:21Z"),
  ];

  const toolCalls = [
    call("tu1", "assess_urgency", { urgency: "urgent", must_call_emergency_services: false, suggested_specialties: ["cardiology"] }),
    call("tu2", "search_providers", { results: [{ id: "p1" }, { id: "p2" }], total: 7 }),
    call("tu3", "recommend_next_step", { ok: true, recommendation_id: recommendation.id }),
  ];

  it("merges each agent turn into one assistant message, hides tool plumbing and attaches the recommendation", () => {
    const view = toConversationView(conversation, messages, toolCalls, [recommendation]);

    expect(view.id).toBe(conversation.id);
    expect(view.locale).toBe("en");
    expect(view.messages).toHaveLength(4);

    expect(view.messages[0]).toEqual({ role: "user", text: "I have chest pain" });

    const turn = view.messages[1];
    expect(turn.role).toBe("assistant");
    if (turn.role !== "assistant") return;
    expect(turn.text).toBe("Let me check how urgent this is.\n\nYou should be seen today.");
    // Same strings the live tool_result events carried (tool-summary.ts).
    expect(turn.toolCalls).toEqual([
      { id: "tu1", name: "assess_urgency", ok: true, summary: "urgent - cardiology", urgency: "urgent" },
      { id: "tu2", name: "search_providers", ok: true, summary: "2 of 7 providers found" },
      { id: "tu3", name: "recommend_next_step", ok: true, summary: "Recommendation saved" },
    ]);
    expect(turn.recommendation).toEqual(recommendation);

    expect(view.messages[2]).toEqual({ role: "user", text: "Thanks" });
    expect(view.messages[3]).toEqual({ role: "assistant", text: "Take care.", toolCalls: [], recommendation: null });
  });

  it("falls back to the recommendation created inside the turn when the tool output has no id", () => {
    const withoutId = toolCalls.map((c) =>
      c.toolUseId === "tu3" ? { ...c, output: { ok: true } } : c,
    );
    const later: Recommendation = { ...recommendation, id: "33333333-3333-4333-8333-333333333333", createdAt: "2026-01-01T00:00:25Z" };
    const view = toConversationView(conversation, messages, withoutId, [later, recommendation]);
    const first = view.messages[1];
    const second = view.messages[3];
    expect(first.role === "assistant" && first.recommendation?.id).toBe(recommendation.id);
    expect(second.role === "assistant" && second.recommendation?.id).toBe(later.id);
  });

  it("marks failed and unrecorded tool calls without exposing the model-facing error text", () => {
    const failed = [
      call("tu1", "assess_urgency", { error: "Invalid input for assess_urgency: symptoms: Too small", summary: "Invalid tool input" }, true),
      call("tu2", "search_providers", { error: "legacy row without a summary" }, true),
    ];
    const view = toConversationView(conversation, messages.slice(0, 4), failed, []);
    const turn = view.messages[1];
    expect(turn.role === "assistant" && turn.toolCalls).toEqual([
      { id: "tu1", name: "assess_urgency", ok: false, summary: "Invalid tool input" },
      { id: "tu2", name: "search_providers", ok: false, summary: "error" },
      { id: "tu3", name: "recommend_next_step", ok: false, summary: "no result recorded" },
    ]);
  });

  it("uses the Arabic provider name for an Arabic conversation, like the live event", () => {
    const details = [call("tu2", "get_provider_details", { id: "p1", nameEn: "Dr. Elif Kaya", nameAr: "د. إيليف كايا" })];
    const view = toConversationView({ ...conversation, locale: "ar" }, messages.slice(0, 5), details, []);
    const turn = view.messages[1];
    expect(turn.role === "assistant" && turn.toolCalls[1].summary).toBe("د. إيليف كايا");
  });

  it("skips the assistant entry for a patient message that got no reply (failed or retried turn)", () => {
    const retried = [
      msg("user", [{ type: "text", text: "I have chest pain" }], "2026-01-01T00:01:00Z"),
      msg("user", [{ type: "text", text: "I have chest pain" }], "2026-01-01T00:01:05Z"),
      msg("assistant", [{ type: "text", text: "How long has it lasted?" }], "2026-01-01T00:01:06Z"),
      msg("user", [{ type: "text", text: "Two hours" }], "2026-01-01T00:01:20Z"),
    ];
    const view = toConversationView(conversation, retried, [], []);
    expect(view.messages).toEqual([
      { role: "user", text: "I have chest pain" },
      { role: "user", text: "I have chest pain" },
      { role: "assistant", text: "How long has it lasted?", toolCalls: [], recommendation: null },
      { role: "user", text: "Two hours" },
    ]);
  });

  it("orders by seq regardless of input order", () => {
    const shuffled = [...messages].reverse();
    const view = toConversationView(conversation, shuffled, toolCalls, [recommendation]);
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
