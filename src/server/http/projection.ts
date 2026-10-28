/**
 * Projects the append-only, verbatim conversation store into the simplified
 * `ConversationView` the UI renders (GET /api/conversations/:id).
 *
 * One UI "assistant message" equals one agent *turn*: every assistant content
 * block produced between two patient messages, with the `tool_result` user
 * messages in between hidden as plumbing. Recommendations are attached from
 * the `recommendations` table, never parsed out of model text.
 */
import {
  URGENCY_LEVELS,
  type ConversationMessageView,
  type ConversationView,
  type Locale,
  type Recommendation,
  type ToolCallView,
  type Urgency,
} from "@/shared/contracts";
import type { StoredConversation, StoredMessage, StoredToolCall } from "@/server/repositories/types";
import { summarizeToolFailure, summarizeToolOutput } from "@/server/agent/tool-summary";

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTextBlock = (block: unknown): block is TextBlock =>
  isRecord(block) && block.type === "text" && typeof block.text === "string";

const isToolUseBlock = (block: unknown): block is ToolUseBlock =>
  isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string";

const isToolResultBlock = (block: unknown): block is ToolResultBlock =>
  isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string";

/** Patient messages carry text; messages made only of tool results are loop plumbing. */
const isPatientMessage = (message: StoredMessage): boolean =>
  message.role === "user" && message.content.some(isTextBlock) && !message.content.some(isToolResultBlock);

function joinText(content: unknown[]): string {
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * Short, human-readable outcome of a tool call for the activity chip: the
 * same text the live `tool_result` event carried (tool-summary.ts), so a
 * reloaded conversation matches what the patient saw while it streamed.
 * Failures show the executor's short label, never the model-facing error.
 */
export function summarizeToolCall(call: StoredToolCall, locale: Locale): string {
  return call.isError ? summarizeToolFailure(call.output) : summarizeToolOutput(call.toolName, call.output, locale);
}

function recommendationIdFrom(call: StoredToolCall): string | null {
  if (call.toolName !== "recommend_next_step" || call.isError || !isRecord(call.output)) return null;
  // The agent's tool output uses snake_case (docs/AGENT.md); accept camelCase defensively.
  const id = call.output.recommendation_id ?? call.output.recommendationId;
  return typeof id === "string" ? id : null;
}

const isUrgency = (value: unknown): value is Urgency =>
  typeof value === "string" && (URGENCY_LEVELS as readonly string[]).includes(value);

/**
 * The rule engine's verdict stored in a successful `assess_urgency` output, so
 * the emergency banner survives a reload the same way it was raised live (from
 * the `tool_result` event). Tolerant: a malformed row simply carries no urgency.
 */
function urgencyFrom(call: StoredToolCall): Urgency | undefined {
  if (call.toolName !== "assess_urgency" || call.isError || !isRecord(call.output)) return undefined;
  return isUrgency(call.output.urgency) ? call.output.urgency : undefined;
}

type Turn = {
  startedAt: number;
  texts: string[];
  toolUses: ToolUseBlock[];
};

export function toConversationView(
  conversation: StoredConversation,
  messages: StoredMessage[],
  toolCalls: StoredToolCall[],
  recommendations: Recommendation[],
): ConversationView {
  const callsByToolUseId = new Map(toolCalls.map((call) => [call.toolUseId, call]));
  const recommendationsById = new Map(recommendations.map((rec) => [rec.id, rec]));
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);

  const toToolCallView = (block: ToolUseBlock): ToolCallView => {
    const call = callsByToolUseId.get(block.id);
    if (!call) return { id: block.id, name: block.name, ok: false, summary: "no result recorded" };
    const urgency = urgencyFrom(call);
    return {
      id: block.id,
      name: call.toolName,
      ok: !call.isError,
      summary: summarizeToolCall(call, conversation.locale),
      ...(urgency ? { urgency } : {}),
    };
  };

  const findRecommendation = (turn: Turn, endedAt: number): Recommendation | null => {
    for (const block of turn.toolUses) {
      const call = callsByToolUseId.get(block.id);
      const id = call ? recommendationIdFrom(call) : null;
      const rec = id ? recommendationsById.get(id) : undefined;
      if (rec) return rec;
    }
    // Fallback for tool outputs without an id: the newest recommendation created
    // inside this turn's time window (after the patient's message, before the next).
    const inWindow = recommendations.filter((rec) => {
      const createdAt = Date.parse(rec.createdAt);
      return createdAt >= turn.startedAt && createdAt < endedAt;
    });
    return inWindow.at(-1) ?? null;
  };

  const views: ConversationMessageView[] = [];
  let turn: Turn | null = null;

  const flushTurn = (endedAt: number): void => {
    if (!turn) return;
    const recommendation = findRecommendation(turn, endedAt);
    // A patient message whose model call failed (or was retried) has no reply;
    // rendering an empty bubble for it would look like a broken answer.
    if (turn.texts.length > 0 || turn.toolUses.length > 0 || recommendation) {
      views.push({
        role: "assistant",
        text: turn.texts.join("\n\n"),
        toolCalls: turn.toolUses.map(toToolCallView),
        recommendation,
      });
    }
    turn = null;
  };

  for (const message of ordered) {
    if (isPatientMessage(message)) {
      flushTurn(message.createdAt.getTime());
      views.push({ role: "user", text: joinText(message.content) });
      turn = { startedAt: message.createdAt.getTime(), texts: [], toolUses: [] };
      continue;
    }
    if (message.role !== "assistant") continue; // tool_result plumbing
    // An assistant message without a preceding patient message cannot happen in
    // a well-formed store, but tolerate it rather than dropping the text.
    turn ??= { startedAt: message.createdAt.getTime(), texts: [], toolUses: [] };
    const text = joinText(message.content);
    if (text) turn.texts.push(text);
    turn.toolUses.push(...message.content.filter(isToolUseBlock));
  }
  flushTurn(Number.POSITIVE_INFINITY);

  return { id: conversation.id, locale: conversation.locale, messages: views };
}
