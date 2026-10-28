/**
 * Scripted stand-in for the Anthropic client used by run-turn tests.
 *
 * Each scripted turn becomes one `stream()` call: the returned object is
 * async-iterable over `content_block_delta`/`text_delta` events (one per text
 * block) and `finalMessage()` resolves to a `BetaMessage`-shaped object. A
 * `throws` turn rejects during iteration, which is where the SDK surfaces
 * API errors; `textBefore` streams text first, the way the SDK's tool-JSON
 * error arrives after earlier blocks. Every call's params are recorded for
 * assertions.
 *
 * The fake also enforces the message-shape rules the real API enforces
 * (`assertValidMessages`), rejecting with a `BadRequestError` like the API
 * would, so a loop that stores an invalid history fails here, not in production.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeClient, ClaudeMessageStream, ClaudeStreamParams } from "@/server/agent/claude";

export type ScriptedTurn =
  | {
      content: Anthropic.Beta.BetaContentBlock[];
      stopReason?: Anthropic.Beta.BetaStopReason;
      stopDetails?: Anthropic.Beta.BetaRefusalStopDetails;
      usage?: Partial<Pick<Anthropic.Beta.BetaUsage, "input_tokens" | "output_tokens" | "cache_read_input_tokens">>;
    }
  | { throws: unknown; textBefore?: string };

export type FakeClaude = {
  client: ClaudeClient;
  /** Params of every `stream()` call, in order. */
  calls: ClaudeStreamParams[];
};

let blockCounter = 0;
const nextId = (prefix: string) => `${prefix}_${(blockCounter += 1).toString().padStart(4, "0")}`;

export const textBlock = (text: string): Anthropic.Beta.BetaTextBlock => ({
  type: "text",
  text,
  citations: null,
});

export const thinkingBlock = (thinking: string, signature = nextId("sig")): Anthropic.Beta.BetaThinkingBlock => ({
  type: "thinking",
  thinking,
  signature,
});

export const toolUseBlock = (name: string, input: unknown, id = nextId("toolu")): Anthropic.Beta.BetaToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

/** A plain assistant reply (clarifying question or interim text). */
export const textTurn = (text: string): ScriptedTurn => ({ content: [textBlock(text)], stopReason: "end_turn" });

/** An assistant turn that requests one or more tools, optionally preceded by text. */
export const toolTurn = (tools: Anthropic.Beta.BetaToolUseBlock[], text?: string): ScriptedTurn => ({
  content: [...(text ? [textBlock(text)] : []), ...tools],
  stopReason: "tool_use",
});

// ---------------------------------------------------------------------------
// Request validation (what the Messages API rejects with 400)
// ---------------------------------------------------------------------------

const KNOWN_BLOCK_TYPES = new Set(["text", "image", "document", "tool_use", "tool_result", "thinking", "redacted_thinking"]);

const badRequest = (message: string): never => {
  throw new Anthropic.BadRequestError(400, { type: "invalid_request_error", message }, message, new Headers());
};

const blocksOf = (message: Anthropic.Beta.BetaMessageParam): Anthropic.Beta.BetaContentBlockParam[] => {
  const { content } = message;
  if (content === undefined) return [];
  return typeof content === "string" ? [{ type: "text", text: content }] : (content as Anthropic.Beta.BetaContentBlockParam[]);
};

const idsOfType = (message: Anthropic.Beta.BetaMessageParam | undefined, type: "tool_use" | "tool_result"): string[] =>
  message === undefined
    ? []
    : blocksOf(message).flatMap((b) =>
        b.type === type ? [type === "tool_use" ? (b as { id: string }).id : (b as { tool_use_id: string }).tool_use_id] : [],
      );

/** Mirrors the API's history invariants; the messages are the loop's own stored history. */
export function assertValidMessages(messages: readonly Anthropic.Beta.BetaMessageParam[]): void {
  if (messages.length === 0) badRequest("messages: at least one message is required");
  if (messages[0].role !== "user") badRequest('messages: first message must use the "user" role');
  messages.forEach((message, i) => {
    const blocks = blocksOf(message);
    const finalAssistant = i === messages.length - 1 && message.role === "assistant";
    if (blocks.length === 0 && !finalAssistant) {
      badRequest(`messages.${i}: all messages must have non-empty content except for the optional final assistant message`);
    }
    for (const block of blocks) {
      if (!KNOWN_BLOCK_TYPES.has(block.type)) badRequest(`messages.${i}.content: unknown block type '${block.type}'`);
      if (block.type === "text" && block.text.length === 0) badRequest(`messages.${i}.content: text content blocks must be non-empty`);
      if (block.type === "tool_result" && block.is_error !== undefined && typeof block.is_error !== "boolean") {
        badRequest(`messages.${i}.content: tool_result.is_error must be a boolean`);
      }
    }
    if (message.role === "assistant") {
      const answered = new Set(idsOfType(messages[i + 1]?.role === "user" ? messages[i + 1] : undefined, "tool_result"));
      for (const id of idsOfType(message, "tool_use")) {
        if (!answered.has(id)) {
          badRequest(
            `messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${id}. ` +
              "Each `tool_use` block must have a corresponding `tool_result` block in the next message.",
          );
        }
      }
    } else {
      const requested = new Set(idsOfType(messages[i - 1]?.role === "assistant" ? messages[i - 1] : undefined, "tool_use"));
      for (const id of idsOfType(message, "tool_result")) {
        if (!requested.has(id)) {
          badRequest(`messages.${i}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${id}`);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Stream construction
// ---------------------------------------------------------------------------

function buildMessage(turn: Exclude<ScriptedTurn, { throws: unknown }>, model: string): Anthropic.Beta.BetaMessage {
  return {
    id: nextId("msg"),
    type: "message",
    role: "assistant",
    model,
    content: turn.content,
    stop_reason: turn.stopReason ?? "end_turn",
    stop_sequence: null,
    stop_details: turn.stopDetails ?? null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: turn.usage?.input_tokens ?? 100,
      output_tokens: turn.usage?.output_tokens ?? 20,
      cache_read_input_tokens: turn.usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

const textDelta = (index: number, text: string): Anthropic.Beta.BetaRawMessageStreamEvent => ({
  type: "content_block_delta",
  index,
  delta: { type: "text_delta", text },
});

function failingStream(failure: unknown, textBefore?: string): ClaudeMessageStream {
  return {
    async *[Symbol.asyncIterator]() {
      if (textBefore) yield textDelta(0, textBefore);
      throw failure;
    },
    finalMessage: () => Promise.reject(failure),
  };
}

function buildStream(turn: ScriptedTurn, model: string): ClaudeMessageStream {
  if ("throws" in turn) return failingStream(turn.throws, turn.textBefore);
  const message = buildMessage(turn, model);
  return {
    async *[Symbol.asyncIterator]() {
      let index = 0;
      for (const block of message.content) {
        if (block.type === "text") yield textDelta(index, block.text);
        index += 1;
      }
    },
    finalMessage: () => Promise.resolve(message),
  };
}

export function createFakeClaude(script: readonly ScriptedTurn[]): FakeClaude {
  const calls: ClaudeStreamParams[] = [];
  const queue = [...script];
  return {
    calls,
    client: {
      beta: {
        messages: {
          stream: (params) => {
            // Snapshot: the loop keeps mutating `messages` after the call returns.
            calls.push(structuredClone(params));
            try {
              assertValidMessages(params.messages);
            } catch (err) {
              return failingStream(err);
            }
            const turn = queue.shift();
            if (!turn) throw new Error(`fake-claude: no scripted turn for call #${calls.length}`);
            return buildStream(turn, params.model);
          },
        },
      },
    },
  };
}
