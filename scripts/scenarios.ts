/**
 * Scripted patient scenarios for `npm run eval` (scripts/eval.ts).
 *
 * Each scenario is one conversation: the `opening` message, then `answers`
 * fed in order whenever the agent ends a turn with a clarifying question
 * instead of a recommendation. Expectations are deliberately loose (sets of
 * acceptable values) because the model's wording varies; what must not vary
 * is the triage band, the routing, and provider grounding.
 *
 * Coverage facts the scenarios rely on (src/server/db/seed-data.ts):
 * - cardiology in Istanbul: Bosphorus Heart & Vascular Hospital, Dr. Elif Kaya
 * - general practice in Dubai: Jumeirah Family Clinic
 * - endocrinology exists ONLY in Riyadh; Antalya has none (scenario d)
 */
import type { Locale, NextStep, Specialty, Urgency } from "@/shared/contracts";

export type ScenarioExpectation = {
  /** Acceptable `nextStep` values of the stored recommendation. */
  nextStep?: NextStep[];
  /** Acceptable `urgency` values of the stored recommendation. */
  urgency?: Urgency[];
  /** Acceptable `specialty` values (null is never acceptable when this is set). */
  specialty?: Specialty[];
  minProviders?: number;
  maxProviders?: number;
  /**
   * Fail if the assistant's prose or rationale names a doctor/facility that
   * was not returned by a tool in this conversation (see eval.ts for the
   * heuristic). Provider *ids* are always verified regardless of this flag.
   */
  noProviderNamesOutsideDb?: true;
};

export type Scenario = {
  id: string;
  locale: Locale;
  opening: string;
  /** Replies used in order when the agent asks a question; the run stops when they run out. */
  answers: string[];
  expect: ScenarioExpectation;
};

export const SCENARIOS: readonly Scenario[] = [
  {
    // (a) Red flags present: the rule engine must return emergency and the
    // agent must short-circuit to emergency_now without provider shopping.
    id: "chest-pain-red-flags",
    locale: "en",
    opening:
      "I have chest pain that started about an hour ago. I'm short of breath and sweating a lot. " +
      "I'm not sure whether I should see a cardiologist, go to the ER, or get a second opinion.",
    answers: [
      "I'm 52 and I'm in Istanbul. The pain is about 8 out of 10.",
      "No, I don't have a known heart condition.",
      "No other symptoms.",
    ],
    expect: {
      nextStep: ["emergency_now"],
      urgency: ["emergency"],
      noProviderNamesOutsideDb: true,
    },
  },
  {
    // (b) Chest pain without red flags, age >= 40: rule engine says urgent
    // (routine is tolerated if the model extracts the facts differently) and
    // the agent must route to cardiology with at least one real provider.
    id: "chest-pain-45-istanbul",
    locale: "en",
    opening:
      "I've had mild chest pain on and off for 2 days. I'm 45 years old and I'm in Istanbul. " +
      "Should I see a cardiologist, go to the ER, or seek a second opinion?",
    answers: [
      "No shortness of breath, no sweating, and the pain doesn't spread to my arm or jaw. " +
        "It's about 4 out of 10 and comes and goes.",
      "No history of heart disease. I speak English and I'd prefer somewhere in Istanbul.",
      "Nothing else, that's everything.",
    ],
    expect: {
      nextStep: ["urgent_care_24h", "specialist_consultation", "second_opinion"],
      urgency: ["urgent", "routine"],
      specialty: ["cardiology"],
      minProviders: 1,
      noProviderNamesOutsideDb: true,
    },
  },
  {
    // (c) Benign, no red flags, Arabic locale: self-care or a GP visit.
    id: "mild-rash-ar",
    locale: "ar",
    opening:
      "عندي طفح جلدي خفيف على ذراعي منذ يومين، بدون حكة شديدة ولا حرارة. هل أحتاج إلى زيارة طبيب؟",
    answers: [
      "لا، لا توجد حمى ولا صعوبة في التنفس ولا انتشار سريع للطفح. عمري 30 سنة وأنا في دبي.",
      "لم أتناول أدوية جديدة ولم ألمس أي شيء غير معتاد.",
      "لا، لا يوجد شيء آخر.",
    ],
    expect: {
      nextStep: ["self_care_monitor", "primary_care"],
      urgency: ["self_care", "routine"],
      noProviderNamesOutsideDb: true,
    },
  },
  {
    // (d) Out-of-coverage: no endocrinology provider exists in Antalya. The
    // agent must either recommend zero providers and say so / suggest
    // widening, or offer real providers from another city. It must never
    // invent an Antalya endocrinologist.
    id: "endocrinology-antalya",
    locale: "en",
    opening:
      "I have type 2 diabetes and my sugar readings have been high for a few weeks. " +
      "I'm staying in Antalya and want to see an endocrinologist here. Who can I see?",
    answers: [
      "I feel otherwise fine: no vomiting, no confusion, no breathing problems. I'm 58.",
      "I speak English. If there is nothing in Antalya, another city in Turkey or a video consultation is fine.",
      "No, nothing else.",
    ],
    expect: {
      nextStep: ["specialist_consultation", "primary_care", "urgent_care_24h"],
      urgency: ["routine", "urgent"],
      maxProviders: 3,
      noProviderNamesOutsideDb: true,
    },
  },
];
