/**
 * Projects the append-only, verbatim conversation store into the simplified
 * `ConversationView` the UI renders (GET /api/conversations/:id).
 *
 * One UI "assistant message" equals one agent *turn*: every assistant content
 * block produced between two patient messages, with the `tool_result` user
 * messages in between hidden as plumbing. Recommendations are attached from
 * the `recommendations` table, never parsed out of model text.
 */
import type {
  ConversationMessageView,
  ConversationView,
  Recommendation,
  ToolCallView,
} from "@/shared/contracts";
import type { StoredConversation, StoredMessage, StoredToolCall } from "@/server/repositories/types";

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
 * Short, human-readable outcome of a tool call for the activity chip. Shapes
 * follow docs/AGENT.md; anything unexpected degrades to "ok"/"error" instead
 * of throwing, because tool outputs are owned by the agent module.
 */
export function summarizeToolCall(call: StoredToolCall): string {
  const output = isRecord(call.output) ? call.output : {};
  if (call.isError) {
    const reason = typeof output.message === "string" ? output.message : typeof output.error === "string" ? output.error : "";
    return reason ? `error: ${reason}` : "error";
  }
  switch (call.toolName) {
    case "assess_urgency":
      return typeof output.urgency === "string" ? output.urgency : "ok";
    case "search_providers": {
      const results = Array.isArray(output.results) ? output.results.length : null;
      const total = typeof output.total === "number" ? output.total : results;
      return results === null ? "ok" : `${results} of ${total ?? results} providers`;
    }
    case "get_provider_details":
      return typeof output.nameEn === "string" ? output.nameEn : "ok";
    case "recommend_next_step":
      return "recommendation saved";
    default:
      return "ok";
  }
}

function recommendationIdFrom(call: StoredToolCall): string | null {
  if (call.toolName !== "recommend_next_step" || call.isError || !isRecord(call.output)) return null;
  // The agent's tool output uses snake_case (docs/AGENT.md); accept camelCase defensively.
  const id = call.output.recommendation_id ?? call.output.recommendationId;
  return typeof id === "string" ? id : null;
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
    return call
      ? { id: block.id, name: call.toolName, ok: !call.isError, summary: summarizeToolCall(call) }
      : { id: block.id, name: block.name, ok: false, summary: "no result recorded" };
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
    views.push({
      role: "assistant",
      text: turn.texts.join("\n\n"),
      toolCalls: turn.toolUses.map(toToolCallView),
      recommendation: findRecommendation(turn, endedAt),
    });
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
