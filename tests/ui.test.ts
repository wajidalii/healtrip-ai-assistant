/**
 * Pure, React-free parts of the chat UI: error copy decisions, SSE event
 * decoding (anti-hallucination: only contract-shaped recommendations reach the
 * card), hydration-failure policy and locale formatting helpers.
 */
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/components/api";
import { describeError, endsConversation } from "@/components/MessageBubble";
import { countryName } from "@/components/ProviderCard";
import {
  decodeAgentEvent,
  initialState,
  isConversationGone,
  reducer,
  showEmergencyBanner,
  type UiError,
  type UiMessage,
} from "@/components/useAgentStream";
import { dictionaries } from "@/i18n/dictionaries";
import type { Recommendation } from "@/shared/contracts";

const err = (over: Partial<UiError>): UiError => ({ code: "unknown", message: "", retryable: false, ...over });

describe("error copy", () => {
  for (const locale of ["en", "ar"] as const) {
    const t = dictionaries[locale];
    it(`[${locale}] non-retryable upstream failures do not promise that retrying helps`, () => {
      expect(describeError(err({ code: "upstream_error", retryable: false }), t)).toBe(t.errors.upstreamUnavailable);
      expect(describeError(err({ code: "upstream_error", retryable: true }), t)).toBe(t.errors.upstream);
      expect(t.errors.upstreamUnavailable).not.toBe(t.errors.upstream);
    });
  }

  it("only a vanished conversation gets the 'start a new conversation' hint", () => {
    expect(endsConversation(err({ code: "not_found" }))).toBe(true);
    for (const code of ["step_limit", "max_tokens", "refusal", "validation_error", "upstream_error"] as const) {
      expect(endsConversation(err({ code }))).toBe(false);
    }
  });
});

describe("decodeAgentEvent", () => {
  const recommendation = {
    id: "0f1a7d7e-9a6c-4e2a-8a53-1b2c3d4e5f60",
    nextStep: "specialist_consultation",
    urgency: "urgent",
    specialty: "cardiology",
    rationale: "Rationale. This is not medical advice.",
    providers: [],
    questionsRemaining: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts the nested contract shape", () => {
    const event = decodeAgentEvent("recommendation", JSON.stringify({ type: "recommendation", recommendation }));
    expect(event?.type).toBe("recommendation");
  });

  it("keeps a contract urgency on tool_result and drops anything else", () => {
    const base = { type: "tool_result", id: "toolu_1", name: "assess_urgency", ok: true, summary: "emergency" };
    expect(decodeAgentEvent("tool_result", JSON.stringify({ ...base, urgency: "emergency" }))).toEqual({
      ...base,
      urgency: "emergency",
    });
    expect(decodeAgentEvent("tool_result", JSON.stringify(base))).toEqual(base);
    expect(decodeAgentEvent("tool_result", JSON.stringify({ ...base, urgency: "critical" }))).toEqual(base);
    expect(decodeAgentEvent("tool_result", JSON.stringify({ ...base, urgency: 3 }))).toEqual(base);
  });

  it("drops a recommendation that is off-contract or not nested", () => {
    expect(decodeAgentEvent("recommendation", JSON.stringify({ type: "recommendation", ...recommendation }))).toBeNull();
    expect(
      decodeAgentEvent(
        "recommendation",
        JSON.stringify({ type: "recommendation", recommendation: { ...recommendation, urgency: "critical" } }),
      ),
    ).toBeNull();
    expect(decodeAgentEvent("recommendation", "not json")).toBeNull();
  });
});

describe("emergency banner", () => {
  const recommendation = (urgency: Recommendation["urgency"]): Recommendation => ({
    id: "0f1a7d7e-9a6c-4e2a-8a53-1b2c3d4e5f60",
    nextStep: urgency === "emergency" ? "emergency_now" : "specialist_consultation",
    urgency,
    specialty: "cardiology",
    rationale: "Rationale. This is not medical advice.",
    providers: [],
    questionsRemaining: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("rises from the assess_urgency tool_result before any recommendation and falls with a later triage", () => {
    let state = reducer(initialState, { type: "turn_started", user: null, assistantId: "a1", replaceAssistantId: null });
    state = reducer(state, {
      type: "tool_call",
      assistantId: "a1",
      item: { id: "t1", name: "assess_urgency", status: "running", summary: "" },
    });
    expect(showEmergencyBanner(state.messages)).toBe(false);

    state = reducer(state, { type: "tool_result", assistantId: "a1", id: "t1", ok: true, summary: "emergency", urgency: "emergency" });
    expect(showEmergencyBanner(state.messages)).toBe(true);
    expect(state.messages[0]).toMatchObject({ toolCalls: [{ id: "t1", status: "ok", urgency: "emergency" }] });

    // The recommendation confirms (it must match the engine), the banner stays; the turn ending changes nothing.
    state = reducer(state, { type: "recommendation", assistantId: "a1", recommendation: recommendation("emergency") });
    state = reducer(state, { type: "turn_done", assistantId: "a1" });
    expect(showEmergencyBanner(state.messages)).toBe(true);

    // A clarifying turn with no triage keeps the previous verdict.
    state = reducer(state, { type: "turn_started", user: null, assistantId: "a2", replaceAssistantId: null });
    state = reducer(state, { type: "text_delta", assistantId: "a2", text: "Are you still short of breath?" });
    state = reducer(state, { type: "turn_done", assistantId: "a2" });
    expect(showEmergencyBanner(state.messages)).toBe(true);

    // A later triage that comes back non-emergency clears it.
    state = reducer(state, { type: "turn_started", user: null, assistantId: "a3", replaceAssistantId: null });
    state = reducer(state, { type: "tool_call", assistantId: "a3", item: { id: "t2", name: "assess_urgency", status: "running", summary: "" } });
    state = reducer(state, { type: "tool_result", assistantId: "a3", id: "t2", ok: true, summary: "routine", urgency: "routine" });
    expect(showEmergencyBanner(state.messages)).toBe(false);
  });

  it("ignores a failed assess_urgency and a tool_result without urgency, and falls back to the recommendation", () => {
    let state = reducer(initialState, { type: "turn_started", user: null, assistantId: "a1", replaceAssistantId: null });
    state = reducer(state, { type: "tool_call", assistantId: "a1", item: { id: "t1", name: "assess_urgency", status: "running", summary: "" } });
    // A failed call never carries a verdict, even if a buggy payload says so.
    state = reducer(state, { type: "tool_result", assistantId: "a1", id: "t1", ok: false, summary: "Invalid tool input", urgency: "emergency" });
    expect(state.messages[0]).toMatchObject({ toolCalls: [{ id: "t1", status: "error" }] });
    expect("urgency" in (state.messages[0] as Extract<UiMessage, { role: "assistant" }>).toolCalls[0]).toBe(false);
    expect(showEmergencyBanner(state.messages)).toBe(false);

    // Older servers / histories: the saved recommendation alone still raises the banner.
    state = reducer(state, { type: "recommendation", assistantId: "a1", recommendation: recommendation("emergency") });
    expect(showEmergencyBanner(state.messages)).toBe(true);
  });

  it("within a turn the engine's latest verdict wins over the recommendation; user messages are skipped", () => {
    const messages: UiMessage[] = [
      { id: "u1", role: "user", text: "chest pain" },
      {
        id: "a1",
        role: "assistant",
        text: "",
        toolCalls: [
          { id: "t1", name: "assess_urgency", status: "ok", summary: "urgent", urgency: "urgent" },
          { id: "t2", name: "assess_urgency", status: "ok", summary: "emergency", urgency: "emergency" },
        ],
        recommendation: recommendation("urgent"),
        error: null,
        streaming: false,
      },
      { id: "u2", role: "user", text: "ok" },
    ];
    expect(showEmergencyBanner(messages)).toBe(true);
    expect(showEmergencyBanner([])).toBe(false);
  });
});

describe("hydration failure policy", () => {
  it("forgets the stored conversation only on 404", () => {
    expect(isConversationGone(new ApiRequestError(404, "not_found", "gone"))).toBe(true);
    expect(isConversationGone(new ApiRequestError(500, "internal_error", "boom"))).toBe(false);
    expect(isConversationGone(new ApiRequestError(502, "upstream_error", "bad gateway"))).toBe(false);
    expect(isConversationGone(new TypeError("Failed to fetch"))).toBe(false);
    expect(isConversationGone(new SyntaxError("Unexpected token"))).toBe(false);
  });
});

describe("locale formatting", () => {
  it("uses a locale-appropriate list separator", () => {
    expect(dictionaries.en.listSeparator).toBe(", ");
    expect(dictionaries.ar.listSeparator).toBe("، ");
  });

  it("maps ISO country codes to localised names and falls back to the code", () => {
    // CLDR spelling varies by ICU version ("Turkey" / "Türkiye").
    expect(countryName("en", "TR")).toMatch(/^T(u|ü)rk/);
    expect(countryName("ar", "AE")).toMatch(/الإمارات/);
    expect(countryName("en", "??")).toBe("??");
  });

  it("uses Western digits in both dictionaries so runtime numbers and copy match", () => {
    const text = JSON.stringify(dictionaries, (_k, v: unknown) => (typeof v === "function" ? undefined : v));
    expect(text).not.toMatch(/[٠-٩]/);
  });
});
