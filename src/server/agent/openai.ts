/**
 * OpenAI credential mode: the Responses API behind the loop's `ClaudeClient`
 * interface (docs/DECISIONS.md ADR-9).
 *
 * The loop speaks the Anthropic Messages shape (content blocks, `tool_use` /
 * `tool_result`, `stop_reason`) and persists that shape verbatim. Rather than
 * teaching the loop a second dialect, this adapter translates at the edge:
 *
 * - request: `system` -> `instructions`; content blocks -> Responses input
 *   items; strict tool definitions -> function tools; `max_tokens` ->
 *   `max_output_tokens`; `output_config.effort` -> `reasoning.effort`.
 * - response: `output_text` -> `text` blocks, `function_call` -> `tool_use`
 *   blocks (`id` = `call_id`), reasoning items -> `redacted_thinking` blocks
 *   whose `data` holds the encrypted reasoning so it can be replayed verbatim
 *   on the next step (the API requires the reasoning item that preceded a
 *   function call to come back with it; `store: false` keeps the
 *   conversation stateless on OpenAI's side, as it is on Anthropic's).
 * - errors: OpenAI SDK errors are re-raised as the equivalent Anthropic SDK
 *   error classes so the loop's single `classifyError` keeps working.
 *
 * What is lost in translation, deliberately: prompt-cache markers (OpenAI
 * caches prefixes automatically), the Anthropic-only `betas` / `fallbacks`,
 * and `strict: true` on tools. OpenAI's strict mode requires every property
 * to be `required` and rejects optional fields, which `search_providers`
 * has; the zod validation in `tools.ts` still rejects any malformed input and
 * tells the model what was wrong, so grounding and urgency enforcement are
 * unchanged.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { ClaudeClient, ClaudeMessageStream, ClaudeStreamOptions, ClaudeStreamParams } from "@/server/agent/claude";

/** The slice of the OpenAI SDK the adapter uses; tests inject a scripted one. */
export type OpenAIResponsesClient = {
  responses: {
    stream: (
      params: ResponseCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ) => AsyncIterable<ResponseStreamEvent> & { finalResponse(): Promise<Response> };
  };
};

export const DEFAULT_OPENAI_MODEL = "gpt-6.1-sol";

type Block = Anthropic.Beta.BetaContentBlock;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;

/** What a `redacted_thinking.data` string carries in this mode. */
type StoredReasoning = { id: string; encrypted_content: string | null };

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

function systemText(system: ClaudeStreamParams["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

function toolResultText(content: Anthropic.Beta.BetaToolResultBlockParam["content"]): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

function parseStoredReasoning(data: string): StoredReasoning | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as StoredReasoning).id === "string") {
      return parsed as StoredReasoning;
    }
  } catch {
    // Not this adapter's block (e.g. history produced in an Anthropic mode); dropped below.
  }
  return null;
}

/** One stored message -> zero or more Responses input items, in order. */
function toInputItems(message: Anthropic.Beta.BetaMessageParam): ResponseInputItem[] {
  const blocks: BlockParam[] =
    typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
  const items: ResponseInputItem[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        items.push({ role: message.role, content: block.text });
        break;
      case "tool_use":
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
        break;
      case "tool_result":
        items.push({ type: "function_call_output", call_id: block.tool_use_id, output: toolResultText(block.content) });
        break;
      case "redacted_thinking": {
        const reasoning = parseStoredReasoning(block.data);
        if (reasoning?.encrypted_content) {
          items.push({ type: "reasoning", id: reasoning.id, encrypted_content: reasoning.encrypted_content, summary: [] });
        }
        break;
      }
      default:
        // `thinking` from an Anthropic-mode history, images, documents: nothing this mode can replay.
        break;
    }
  }
  return items;
}

function toFunctionTools(tools: ClaudeStreamParams["tools"]): FunctionTool[] {
  if (!tools) return [];
  const out: FunctionTool[] = [];
  for (const tool of tools) {
    if (!("input_schema" in tool)) continue; // server tools (web search etc.) are never sent by this project
    out.push({
      type: "function",
      name: tool.name,
      description: tool.description ?? null,
      parameters: tool.input_schema as Record<string, unknown>,
      strict: false,
    });
  }
  return out;
}

export function toResponsesParams(params: ClaudeStreamParams): ResponseCreateParamsStreaming {
  const instructions = systemText(params.system);
  const effort = params.output_config?.effort;
  return {
    model: params.model,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(instructions ? { instructions } : {}),
    input: params.messages.flatMap(toInputItems),
    tools: toFunctionTools(params.tools),
    max_output_tokens: params.max_tokens,
    ...(effort ? { reasoning: { effort } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

/** The SDK's own "unreadable tool input" failure, so the loop's `isToolJsonError` re-issues the step. */
const toolJsonError = (name: string, cause: unknown): Error =>
  new Anthropic.AnthropicError(`Could not parse the arguments of tool call ${name}: ${String(cause)}`);

function stopReason(response: Response, hasToolUse: boolean): Anthropic.Beta.BetaStopReason {
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "content_filter" ? "refusal" : "max_tokens";
  }
  if (response.output.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal"))) {
    return "refusal";
  }
  return hasToolUse ? "tool_use" : "end_turn";
}

export function toBetaMessage(response: Response): Anthropic.Beta.BetaMessage {
  const content: Block[] = [];
  for (const item of response.output) {
    switch (item.type) {
      case "message":
        for (const part of item.content) {
          if (part.type === "output_text" && part.text.length > 0) {
            content.push({ type: "text", text: part.text, citations: null });
          }
        }
        break;
      case "function_call": {
        let input: unknown;
        try {
          input = item.arguments.trim() === "" ? {} : JSON.parse(item.arguments);
        } catch (err) {
          throw toolJsonError(item.name, err);
        }
        content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
        break;
      }
      case "reasoning": {
        const stored: StoredReasoning = { id: item.id, encrypted_content: item.encrypted_content ?? null };
        content.push({ type: "redacted_thinking", data: JSON.stringify(stored) });
        break;
      }
      default:
        break;
    }
  }
  const hasToolUse = content.some((block) => block.type === "tool_use");
  const usage = response.usage;
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content,
    stop_reason: stopReason(response, hasToolUse),
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_read_input_tokens: usage?.input_tokens_details?.cached_tokens ?? 0,
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** OpenAI SDK errors -> the Anthropic SDK classes the loop already classifies. Anything else passes through. */
export function toAnthropicError(err: unknown): unknown {
  if (err instanceof OpenAI.APIUserAbortError) return new Anthropic.APIUserAbortError({ message: err.message });
  if (err instanceof OpenAI.APIConnectionError) return new Anthropic.APIConnectionError({ message: err.message });
  if (err instanceof OpenAI.APIError) {
    return Anthropic.APIError.generate(err.status, err.error, err.message, err.headers ?? new Headers());
  }
  return err;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function toClaudeStream(
  source: AsyncIterable<ResponseStreamEvent> & { finalResponse(): Promise<Response> },
): ClaudeMessageStream {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of source) {
          if (event.type === "response.output_text.delta") {
            yield { type: "content_block_delta", index: event.output_index, delta: { type: "text_delta", text: event.delta } };
          }
        }
      } catch (err) {
        throw toAnthropicError(err);
      }
    },
    async finalMessage() {
      let response: Response;
      try {
        response = await source.finalResponse();
      } catch (err) {
        throw toAnthropicError(err);
      }
      return toBetaMessage(response);
    },
  };
}

/** Wraps any Responses-capable client; `createOpenAIClient` is the production binding. */
export function createOpenAIAdapter(openai: OpenAIResponsesClient): ClaudeClient {
  return {
    beta: {
      messages: {
        stream: (params: ClaudeStreamParams, options?: ClaudeStreamOptions) =>
          toClaudeStream(openai.responses.stream(toResponsesParams(params), options)),
      },
    },
  };
}

export function createOpenAIClient(apiKey: string): ClaudeClient {
  return createOpenAIAdapter(new OpenAI({ apiKey }));
}
