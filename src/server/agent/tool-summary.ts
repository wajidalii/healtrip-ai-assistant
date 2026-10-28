/**
 * One short, human-readable line per tool outcome for the UI activity chip.
 *
 * Used by the executors (live `tool_result` SSE event) and by the GET
 * projection (reload), so a conversation shows the same chip text before and
 * after a page reload. Summaries are derived from the persisted *output*
 * only, never from the model-facing error text, which can carry plumbing
 * (allowed ids, zod issues) that is not meant for the patient. Parsing is
 * tolerant: an unexpected shape degrades to "ok", never throws.
 */
import type { Locale } from "@/shared/contracts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Summary of a *successful* call, from its persisted output. */
export function summarizeToolOutput(toolName: string, output: unknown, locale: Locale): string {
  const data = isRecord(output) ? output : {};
  switch (toolName) {
    case "assess_urgency": {
      if (data.must_call_emergency_services === true) return "emergency - call emergency services";
      if (typeof data.urgency !== "string") return "ok";
      const specialties = Array.isArray(data.suggested_specialties) ? data.suggested_specialties : [];
      const first = typeof specialties[0] === "string" ? specialties[0] : "general_practice";
      return `${data.urgency} - ${first}`;
    }
    case "search_providers": {
      if (!Array.isArray(data.results)) return "ok";
      const shown = data.results.length;
      if (shown === 0) return "No providers found";
      const total = typeof data.total === "number" && data.total > shown ? ` of ${data.total}` : "";
      return `${shown}${total} ${shown === 1 && !total ? "provider" : "providers"} found`;
    }
    case "get_provider_details": {
      const name = locale === "ar" ? data.nameAr : data.nameEn;
      return typeof name === "string" ? name : typeof data.nameEn === "string" ? data.nameEn : "ok";
    }
    case "recommend_next_step":
      return "Recommendation saved";
    default:
      return "ok";
  }
}

/**
 * Summary of a *failed* call. Failed calls are persisted as
 * `{ error, summary }` (run-turn.ts); only the short `summary` written by the
 * executor is shown, the `error` text is for the model.
 */
export function summarizeToolFailure(output: unknown): string {
  const data = isRecord(output) ? output : {};
  return typeof data.summary === "string" && data.summary.length > 0 ? data.summary : "error";
}
