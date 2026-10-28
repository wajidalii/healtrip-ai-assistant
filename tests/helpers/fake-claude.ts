/**
 * Scripted stand-in for the Anthropic client used by run-turn tests.
 *
 * Each scripted turn becomes one `stream()` call: the returned object is
 * async-iterable over `content_block_delta`/`text_delta` events (one per text
 * block) and `finalMessage()` resolves to a `BetaMessage`-shaped object. A
 * `throws` turn rejects during iteration, which is where the SDK surfaces
 * API errors. Every call's params are recorded for assertions.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeClient, ClaudeMessageStream, ClaudeStreamParams } from "@/server/agent/claude";

export type ScriptedTurn =
  | {
      content: Anthropic.Beta.BetaContentBlock[];
      stopReason?: Anthropic.Beta.BetaStopReason;
      usage?: Partial<Pick<Anthropic.Beta.BetaUsage, "input_tokens" | "output_tokens" | "cache_read_input_tokens">>;
    }
  | { throws: unknown };

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

function buildMessage(turn: Exclude<ScriptedTurn, { throws: unknown }>, model: string): Anthropic.Beta.BetaMessage {
  return {
    id: nextId("msg"),
    type: "message",
    role: "assistant",
    model,
    content: turn.content,
    stop_reason: turn.stopReason ?? "end_turn",
    stop_sequence: null,
    stop_details: null,
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

function buildStream(turn: ScriptedTurn, model: string): ClaudeMessageStream {
  if ("throws" in turn) {
    const failure = turn.throws;
    return {
      async *[Symbol.asyncIterator]() {
        throw failure;
      },
      finalMessage: () => Promise.reject(failure),
    };
  }
  const message = buildMessage(turn, model);
  return {
    async *[Symbol.asyncIterator]() {
      let index = 0;
      for (const block of message.content) {
        if (block.type === "text") {
          yield { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } };
        }
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
            const turn = queue.shift();
            if (!turn) throw new Error(`fake-claude: no scripted turn for call #${calls.length}`);
            return buildStream(turn, params.model);
          },
        },
      },
    },
  };
}
