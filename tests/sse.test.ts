/**
 * UI-side SSE layer: the wire parser (`parseSse`) and the event decoder
 * (`decodeAgentEvent`). Both are React-free, so they are exercised here with a
 * plain web `ReadableStream` and the real `TextEncoder` — including chunk
 * boundaries that fall mid-line and mid-multibyte-character, which is what a
 * real fetch body does.
 */
import { describe, expect, it } from "vitest";
import { parseSse, type SseMessage } from "@/components/sse";
import { decodeAgentEvent } from "@/components/useAgentStream";
import type { AgentEvent, Recommendation } from "@/shared/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A body that delivers each chunk as its own `read()`; byte chunks are passed through untouched. */
function bodyOf(chunks: ReadonlyArray<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function collect(chunks: ReadonlyArray<string | Uint8Array>, signal?: AbortSignal): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const msg of parseSse(bodyOf(chunks), signal)) out.push(msg);
  return out;
}

/** Splits UTF-8 bytes at an arbitrary byte offset, possibly inside a code point. */
function splitBytes(text: string, at: number): [Uint8Array, Uint8Array] {
  const bytes = new TextEncoder().encode(text);
  return [bytes.slice(0, at), bytes.slice(at)];
}

const FRAME_A = 'event: text_delta\ndata: {"type":"text_delta","text":"a"}\n\n';
const FRAME_B = 'event: text_delta\ndata: {"type":"text_delta","text":"b"}\n\n';
const MSG_A: SseMessage = { event: "text_delta", data: '{"type":"text_delta","text":"a"}' };
const MSG_B: SseMessage = { event: "text_delta", data: '{"type":"text_delta","text":"b"}' };

// ---------------------------------------------------------------------------
// parseSse
// ---------------------------------------------------------------------------

describe("parseSse", () => {
  it("parses the server's `event:` + `data:` frame shape, one message per blank line", async () => {
    expect(await collect([FRAME_A + FRAME_B])).toEqual([MSG_A, MSG_B]);
  });

  it("reassembles a frame split across chunks in the middle of a line", async () => {
    const cut = FRAME_A.indexOf('"text"');
    expect(await collect([FRAME_A.slice(0, cut), FRAME_A.slice(cut)])).toEqual([MSG_A]);
    // A split between the two newlines of the frame terminator must not drop or duplicate anything.
    expect(await collect([FRAME_A.slice(0, -1), FRAME_A.slice(-1), FRAME_B])).toEqual([MSG_A, MSG_B]);
  });

  it("decodes a chunk boundary that falls inside a multibyte character", async () => {
    // Arabic text (3 bytes per letter) and a 4-byte emoji, so the split is guaranteed mid-code-point.
    const text = "ألم في الصدر 🫀";
    const frame = `event: text_delta\ndata: ${JSON.stringify({ type: "text_delta", text })}\n\n`;
    const bytes = new TextEncoder().encode(frame);
    const dataOffset = new TextEncoder().encode('event: text_delta\ndata: {"type":"text_delta","text":"').length;
    // One chunk per byte around the payload: every multibyte sequence gets cut at every position.
    const chunks: Uint8Array[] = [bytes.slice(0, dataOffset)];
    for (let i = dataOffset; i < bytes.length; i++) chunks.push(bytes.slice(i, i + 1));
    const [msg] = await collect(chunks);
    expect(JSON.parse(msg.data)).toEqual({ type: "text_delta", text });
    // Sanity check: the two-chunk helper really does split inside a code point.
    const [head, tail] = splitBytes(frame, dataOffset + 1);
    expect(head.length + tail.length).toBe(bytes.length);
    expect(await collect([head, tail])).toEqual([{ event: "text_delta", data: JSON.stringify({ type: "text_delta", text }) }]);
  });

  it("accepts CRLF line endings", async () => {
    const crlf = FRAME_A.replaceAll("\n", "\r\n");
    expect(await collect([crlf])).toEqual([MSG_A]);
  });

  it("accepts lone CR line endings", async () => {
    const cr = FRAME_A.replaceAll("\n", "\r");
    expect(await collect([cr])).toEqual([MSG_A]);
  });

  it("holds a trailing CR back until the next chunk so a CRLF split across chunks is one terminator", async () => {
    const crlf = FRAME_A.replaceAll("\n", "\r\n");
    // Split right between "\r" and "\n" of the data line's terminator, and again inside the final "\r\n\r\n".
    const firstCut = crlf.indexOf("\r\n") + 1;
    const out = await collect([crlf.slice(0, firstCut), crlf.slice(firstCut, -3), crlf.slice(-3)]);
    expect(out).toEqual([MSG_A]);
  });

  it("ignores comment lines such as the server heartbeat, including the blank line after them", async () => {
    const out = await collect([": heartbeat\n\n", FRAME_A, ":another comment\n", ": heartbeat\n\n", FRAME_B]);
    expect(out).toEqual([MSG_A, MSG_B]);
  });

  it("does not let a comment inside a frame terminate or alter it", async () => {
    const out = await collect(["event: text_delta\n: mid-frame\ndata: {\"x\":1}\n\n"]);
    expect(out).toEqual([{ event: "text_delta", data: '{"x":1}' }]);
  });

  it("joins multi-line data with a single newline", async () => {
    expect(await collect(["data: line one\ndata: line two\ndata: line three\n\n"])).toEqual([
      { event: "message", data: "line one\nline two\nline three" },
    ]);
  });

  it("strips exactly one leading space from a field value", async () => {
    expect(await collect(["data:nospace\n\n", "data:  two spaces\n\n"])).toEqual([
      { event: "message", data: "nospace" },
      { event: "message", data: " two spaces" },
    ]);
  });

  it("ignores an event with no data and does not leak its name into the next frame", async () => {
    const out = await collect(["event: ghost\n\n", "data: {}\n\n"]);
    expect(out).toEqual([{ event: "message", data: "{}" }]);
  });

  it("ignores fields this API does not use (id, retry, unknown)", async () => {
    const out = await collect(["id: 7\nretry: 1000\nfoo: bar\nevent: done\ndata: {}\n\n"]);
    expect(out).toEqual([{ event: "done", data: "{}" }]);
  });

  it("holds a trailing partial frame until the next chunk completes it", async () => {
    const seen: SseMessage[] = [];
    const encoder = new TextEncoder();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(FRAME_A + FRAME_B.slice(0, -1)));
        await gate;
        controller.enqueue(encoder.encode(FRAME_B.slice(-1)));
        controller.close();
      },
    });
    const iterator = parseSse(body);
    seen.push((await iterator.next()).value as SseMessage);
    expect(seen).toEqual([MSG_A]);
    // Nothing else can be produced until the terminator arrives.
    const pending = iterator.next();
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    expect((await pending).value).toEqual(MSG_B);
    expect((await iterator.next()).done).toBe(true);
  });

  it("discards a frame that is still open when the stream ends", async () => {
    // Frames cut before the blank line are exactly what a dropped connection produces.
    expect(await collect([FRAME_A, 'event: done\ndata: {"type":"done"'])).toEqual([MSG_A]);
    expect(await collect([FRAME_A, 'event: done\ndata: {"type":"done"}\n'])).toEqual([MSG_A]);
    expect(await collect([FRAME_A, "event: done\n"])).toEqual([MSG_A]);
    expect(await collect([FRAME_A, "data: {}\r"])).toEqual([MSG_A]);
    expect(await collect([])).toEqual([]);
    expect(await collect([""])).toEqual([]);
  });

  it("still dispatches a complete frame whose closing blank line is a bare CR at the very end", async () => {
    expect(await collect(["event: done\rdata: {}\r\r"])).toEqual([{ event: "done", data: "{}" }]);
    expect(await collect(["event: done\ndata: {}\n", "\r"])).toEqual([{ event: "done", data: "{}" }]);
  });

  it("releases the reader lock when the stream ends", async () => {
    const body = bodyOf([FRAME_A]);
    const out: SseMessage[] = [];
    for await (const msg of parseSse(body)) out.push(msg);
    expect(out).toEqual([MSG_A]);
    expect(body.locked).toBe(false);
  });

  it("stops without reading further once the signal is aborted, and releases the lock", async () => {
    const controller = new AbortController();
    const body = bodyOf([FRAME_A, FRAME_B]);
    const out: SseMessage[] = [];
    for await (const msg of parseSse(body, controller.signal)) {
      out.push(msg);
      controller.abort();
    }
    expect(out).toEqual([MSG_A]);
    expect(body.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decodeAgentEvent
// ---------------------------------------------------------------------------

const recommendation: Recommendation = {
  id: "0f1a7d7e-9a6c-4e2a-8a53-1b2c3d4e5f60",
  nextStep: "specialist_consultation",
  urgency: "urgent",
  specialty: "cardiology",
  rationale: "Chest pain with radiation warrants prompt cardiology review. This is not medical advice.",
  providers: [
    {
      id: "6f9b2c1e-3d4a-4b5c-9e8f-0a1b2c3d4e5f",
      kind: "hospital",
      nameEn: "Example Heart Centre",
      nameAr: "مركز القلب النموذجي",
      specialties: ["cardiology"],
      city: "Istanbul",
      country: "TR",
      languages: ["en", "tr", "ar"],
      emergencyCapable: true,
      telemedicine: false,
      acceptsInternational: true,
      rating: 4.6,
      priceTier: "mid",
    },
  ],
  questionsRemaining: ["How long has the pain lasted?"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** One representative of every `AgentEvent` variant, keyed by type so the test fails if the union grows. */
const EVERY_EVENT: { [T in AgentEvent["type"]]: Extract<AgentEvent, { type: T }> } = {
  conversation: { type: "conversation", conversationId: "c9c5a9d4-2f44-4d7b-9d2a-8b7e6f5a4c3b" },
  text_delta: { type: "text_delta", text: "Hello" },
  tool_call: { type: "tool_call", id: "toolu_1", name: "assess_urgency", input: { symptoms: ["chest pain"] } },
  tool_result: { type: "tool_result", id: "toolu_1", name: "assess_urgency", ok: true, summary: "urgent - cardiology" },
  recommendation: { type: "recommendation", recommendation },
  done: { type: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5 } },
  error: { type: "error", code: "upstream_error", message: "Model unavailable", retryable: true },
};

/** Mirrors the server's `encodeEvent`: the event name is the type and the data is the whole event. */
function wire(event: AgentEvent): [string, string] {
  return [event.type, JSON.stringify(event)];
}

describe("decodeAgentEvent", () => {
  it("round-trips every AgentEvent variant from the server's wire shape", () => {
    for (const event of Object.values(EVERY_EVENT)) {
      expect(decodeAgentEvent(...wire(event))).toEqual(event);
    }
  });

  it("falls back to data.type when the frame has no event name", () => {
    for (const event of Object.values(EVERY_EVENT)) {
      expect(decodeAgentEvent("message", JSON.stringify(event))).toEqual(event);
    }
  });

  it("lets the event name win over data.type", () => {
    const decoded = decodeAgentEvent("text_delta", JSON.stringify({ type: "done", text: "hi" }));
    expect(decoded).toEqual({ type: "text_delta", text: "hi" });
  });

  it("drops malformed JSON and non-object payloads", () => {
    expect(decodeAgentEvent("text_delta", "not json")).toBeNull();
    expect(decodeAgentEvent("text_delta", '{"type":"text_delta","text":"a"')).toBeNull();
    expect(decodeAgentEvent("text_delta", "")).toBeNull();
    expect(decodeAgentEvent("text_delta", "null")).toBeNull();
    expect(decodeAgentEvent("text_delta", "42")).toBeNull();
    expect(decodeAgentEvent("text_delta", '"text_delta"')).toBeNull();
  });

  it("drops unknown event types", () => {
    expect(decodeAgentEvent("heartbeat", "{}")).toBeNull();
    expect(decodeAgentEvent("message", JSON.stringify({ type: "thinking", text: "..." }))).toBeNull();
    expect(decodeAgentEvent("message", "{}")).toBeNull();
    expect(decodeAgentEvent("message", "[]")).toBeNull();
  });

  it("drops variants whose required fields are missing or mistyped", () => {
    expect(decodeAgentEvent("conversation", JSON.stringify({ conversationId: 42 }))).toBeNull();
    expect(decodeAgentEvent("text_delta", JSON.stringify({ text: ["a"] }))).toBeNull();
    expect(decodeAgentEvent("tool_call", JSON.stringify({ id: "toolu_1" }))).toBeNull();
    expect(decodeAgentEvent("tool_result", JSON.stringify({ id: "toolu_1", name: "x", ok: "yes" }))).toBeNull();
    expect(decodeAgentEvent("error", JSON.stringify({ message: "no code" }))).toBeNull();
  });

  it("drops a recommendation that fails recommendationSchema (anti-hallucination gate)", () => {
    const bad = (patch: Record<string, unknown>) =>
      decodeAgentEvent("recommendation", JSON.stringify({ type: "recommendation", recommendation: { ...recommendation, ...patch } }));
    expect(bad({ urgency: "critical" })).toBeNull();
    expect(bad({ nextStep: "surgery_now" })).toBeNull();
    expect(bad({ specialty: "cardiac" })).toBeNull();
    expect(bad({ id: "not-a-uuid" })).toBeNull();
    expect(bad({ providers: [{ ...recommendation.providers[0], rating: 7 }] })).toBeNull();
    expect(bad({ providers: [{ ...recommendation.providers[0], country: "TUR" }] })).toBeNull();
    expect(bad({ providers: [{ name: "Free-text provider the model made up" }] })).toBeNull();
    // Flattened (not nested under `recommendation`) and missing entirely.
    expect(decodeAgentEvent("recommendation", JSON.stringify({ type: "recommendation", ...recommendation }))).toBeNull();
    expect(decodeAgentEvent("recommendation", JSON.stringify({ type: "recommendation" }))).toBeNull();
  });

  it("accepts a recommendation with a null specialty and no providers", () => {
    const sparse = { ...recommendation, specialty: null, providers: [], questionsRemaining: [] };
    const decoded = decodeAgentEvent("recommendation", JSON.stringify({ type: "recommendation", recommendation: sparse }));
    expect(decoded).toEqual({ type: "recommendation", recommendation: sparse });
  });

  it("is lenient about optional detail on terminal and tool events", () => {
    expect(decodeAgentEvent("done", "{}")).toEqual({
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    });
    expect(decodeAgentEvent("done", JSON.stringify({ stopReason: "max_tokens", usage: { inputTokens: "3" } }))).toEqual({
      type: "done",
      stopReason: "max_tokens",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    });
    expect(decodeAgentEvent("error", JSON.stringify({ code: "step_limit" }))).toEqual({
      type: "error",
      code: "step_limit",
      message: "",
      retryable: false,
    });
    // A string "true" is not a boolean true: only a real boolean unlocks the retry button.
    expect(decodeAgentEvent("error", JSON.stringify({ code: "step_limit", retryable: "true" }))).toEqual({
      type: "error",
      code: "step_limit",
      message: "",
      retryable: false,
    });
    expect(decodeAgentEvent("tool_result", JSON.stringify({ id: "t", name: "n", ok: false }))).toEqual({
      type: "tool_result",
      id: "t",
      name: "n",
      ok: false,
      summary: "",
    });
  });
});

describe("parseSse + decodeAgentEvent", () => {
  it("decodes a realistic server stream with heartbeats, chunked arbitrarily, into the contract events", async () => {
    const stream = [
      ": heartbeat\n\n",
      ...Object.values(EVERY_EVENT).map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
    ].join("");
    // Chunk at a fixed byte size so boundaries land inside lines and inside the Arabic provider name.
    const bytes = new TextEncoder().encode(stream);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
    const decoded: AgentEvent[] = [];
    for (const msg of await collect(chunks)) {
      const event = decodeAgentEvent(msg.event, msg.data);
      if (event) decoded.push(event);
    }
    expect(decoded).toEqual(Object.values(EVERY_EVENT));
  });
});
