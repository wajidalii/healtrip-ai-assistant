/**
 * Red-flag triage rule table. This file is DATA, not prose: every rule is a
 * small predicate over normalized facts plus the urgency and specialties it
 * implies. Keeping it tabular lets a clinician review thresholds line by line
 * and lets tests/triage.test.ts pin each rule down. See docs/AGENT.md
 * ("Why a rule engine for urgency").
 *
 * Precedence is NOT encoded here: the engine evaluates every rule and keeps
 * the highest urgency, so a rule only has to describe its own trigger.
 */
import type { RedFlag, Specialty, Urgency } from "@/shared/contracts";

/**
 * Normalized view of a triage request that rule predicates read from.
 * Symptom strings are already trimmed and lowercased by the input schema.
 */
export type TriageFacts = {
  /** True if any symptom string matches the keyword/regex (or any regex of a concept). */
  hasSymptom(matcher: Concept | RegExp | string): boolean;
  hasFlag(flag: RedFlag): boolean;
  /** True if at least one of the given flags is present (any flag at all when the list is empty). */
  hasAnyFlag(flags?: readonly RedFlag[]): boolean;
  readonly severity: number | undefined;
  readonly durationHours: number | undefined;
  readonly age: number | undefined;
};

export type Rule = {
  /** Stable id used in logs/evals; renaming one is a behaviour change. */
  id: string;
  description: string;
  urgency: Urgency;
  specialties: readonly Specialty[];
  when: (facts: TriageFacts) => boolean;
};

// ---------------------------------------------------------------------------
// Concept matchers
//
// The model paraphrases what the patient wrote, so a single keyword is too
// brittle ("pain in my chest", "chest tightness"). Each concept is a list of
// regexes; any match counts. Patterns are deliberately simple and anchored on
// word boundaries to avoid matching e.g. "checkup" for "chest".
// ---------------------------------------------------------------------------

export type Concept = readonly RegExp[];

export const CHEST_PAIN: Concept = [
  /\bchest\b.*\b(pain|ache|aching|tight(ness)?|pressure|heav(y|iness)|discomfort|squeez\w*|burn\w*)\b/,
  /\b(pain|ache|tight(ness)?|pressure|heaviness|discomfort)\b.*\bchest\b/,
  /\bangina\b/,
];

export const HEADACHE: Concept = [/\bhead ?aches?\b/, /\bmigraines?\b/, /\b(pain|ache)\b.*\bhead\b/];

export const RASH: Concept = [
  /\brash(es)?\b/,
  /\bhives\b/,
  /\b(itch\w*|eczema|psoriasis|acne)\b/,
  /\b(moles?|skin (spot|lesion|growth|patch|change)s?)\b/,
  /\bskin\b.*\b(itch\w*|rash|peel\w*|blister\w*)\b/,
];

/** Flags that, together with chest pain, suggest an acute coronary syndrome. */
const CHEST_PAIN_EMERGENCY_FLAGS: readonly RedFlag[] = [
  "shortness_of_breath",
  "pain_radiating_arm_or_jaw",
  "sweating_or_nausea_with_pain",
  "fainting_or_near_fainting",
];

/** FAST stroke signs plus thunderclap headache (possible subarachnoid haemorrhage). */
const STROKE_FLAGS: readonly RedFlag[] = [
  "face_droop",
  "arm_weakness",
  "speech_difficulty",
  "sudden_severe_headache",
];

const gte = (value: number | undefined, threshold: number): boolean =>
  value !== undefined && value >= threshold;
const lte = (value: number | undefined, threshold: number): boolean =>
  value !== undefined && value <= threshold;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const RULES: readonly Rule[] = [
  // --- Chest pain ----------------------------------------------------------
  {
    id: "chest_pain_red_flags",
    description:
      "Chest pain with shortness of breath, radiation to arm/jaw, sweating/nausea, fainting, or known heart disease with severity >= 7",
    urgency: "emergency",
    specialties: ["cardiology", "emergency_medicine"],
    when: (f) =>
      f.hasSymptom(CHEST_PAIN) &&
      (f.hasAnyFlag(CHEST_PAIN_EMERGENCY_FLAGS) ||
        (f.hasFlag("known_heart_disease") && gte(f.severity, 7))),
  },
  {
    id: "chest_pain_risk_factors",
    description: "Chest pain with severity >= 7, age >= 40, or known heart disease",
    urgency: "urgent",
    specialties: ["cardiology", "emergency_medicine"],
    when: (f) =>
      f.hasSymptom(CHEST_PAIN) &&
      (gte(f.severity, 7) || gte(f.age, 40) || f.hasFlag("known_heart_disease")),
  },
  {
    // Chest pain is never self-care in this prototype: the engine's
    // precedence lets the two rules above override this one when they fire.
    id: "chest_pain",
    description: "Chest pain without red flags or risk factors",
    urgency: "routine",
    specialties: ["cardiology", "general_practice"],
    when: (f) => f.hasSymptom(CHEST_PAIN),
  },

  // --- Neurological --------------------------------------------------------
  {
    id: "stroke_signs",
    description: "Face droop, arm weakness, speech difficulty or sudden severe headache (FAST)",
    urgency: "emergency",
    specialties: ["neurology", "emergency_medicine"],
    when: (f) => f.hasAnyFlag(STROKE_FLAGS),
  },
  {
    id: "meningitis_signs",
    description: "High fever with stiff neck",
    urgency: "emergency",
    specialties: ["emergency_medicine", "neurology"],
    when: (f) => f.hasFlag("high_fever_with_stiff_neck"),
  },
  {
    id: "severe_or_persistent_headache",
    description: "Headache with severity >= 8 or lasting more than 72 hours",
    urgency: "urgent",
    specialties: ["neurology"],
    when: (f) => f.hasSymptom(HEADACHE) && (gte(f.severity, 8) || (f.durationHours ?? 0) > 72),
  },
  {
    id: "vision_loss",
    description: "Loss of vision",
    urgency: "urgent",
    specialties: ["ophthalmology"],
    when: (f) => f.hasFlag("vision_loss"),
  },

  // --- Other emergencies ---------------------------------------------------
  {
    id: "severe_bleeding",
    description: "Severe bleeding",
    urgency: "emergency",
    specialties: ["emergency_medicine"],
    when: (f) => f.hasFlag("severe_bleeding"),
  },
  {
    id: "difficulty_breathing",
    description: "Difficulty breathing",
    urgency: "emergency",
    specialties: ["emergency_medicine", "pulmonology"],
    when: (f) => f.hasFlag("difficulty_breathing"),
  },
  {
    id: "suicidal_thoughts",
    description: "Suicidal thoughts",
    urgency: "emergency",
    specialties: ["psychiatry", "emergency_medicine"],
    when: (f) => f.hasFlag("suicidal_thoughts"),
  },
  {
    id: "abdominal_pain_pregnancy",
    description: "Severe abdominal pain during pregnancy",
    urgency: "emergency",
    specialties: ["emergency_medicine"],
    when: (f) => f.hasFlag("severe_abdominal_pain") && f.hasFlag("pregnancy"),
  },
  {
    id: "severe_abdominal_pain",
    description: "Severe abdominal pain",
    urgency: "urgent",
    specialties: ["gastroenterology", "emergency_medicine"],
    when: (f) => f.hasFlag("severe_abdominal_pain"),
  },

  // --- Routine / self-care -------------------------------------------------
  {
    id: "skin_complaint",
    description: "Rash, itching or changes to a mole",
    urgency: "routine",
    specialties: ["dermatology"],
    when: (f) => f.hasSymptom(RASH),
  },
  {
    // Requires severity AND duration to be known: with missing facts we
    // prefer the conservative fallback (routine) over telling someone to
    // stay home.
    id: "mild_short_lived",
    description: "Mild symptoms (severity <= 3) for at most 72 hours with no red flags",
    urgency: "self_care",
    specialties: ["general_practice"],
    when: (f) => lte(f.severity, 3) && lte(f.durationHours, 72) && !f.hasAnyFlag(),
  },
];

/**
 * Applied by the engine only when no rule in RULES matched. Kept out of RULES
 * so it does not show up in `matchedRules` next to a real routine rule.
 */
export const FALLBACK_RULE: Rule = {
  id: "fallback",
  description: "No specific rule matched; see a general practitioner",
  urgency: "routine",
  specialties: ["general_practice"],
  when: () => true,
};
