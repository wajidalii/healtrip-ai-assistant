/**
 * Pure, React-free parts of the chat UI: error copy decisions, SSE event
 * decoding (anti-hallucination: only contract-shaped recommendations reach the
 * card), hydration-failure policy and locale formatting helpers.
 */
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/components/api";
import { describeError, endsConversation } from "@/components/MessageBubble";
import { countryName } from "@/components/ProviderCard";
import { decodeAgentEvent, isConversationGone, type UiError } from "@/components/useAgentStream";
import { dictionaries } from "@/i18n/dictionaries";

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
