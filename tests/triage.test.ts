import { describe, expect, it } from "vitest";
import { assessUrgency, triageInputSchema, RULES, type TriageInput } from "@/server/triage";

/** Parses through the schema so tests exercise the same normalization the tool does. */
const assess = (raw: unknown) => assessUrgency(triageInputSchema.parse(raw));
const ruleIds = (raw: unknown) => assess(raw).matchedRules.map((r) => r.id);

describe("triageInputSchema", () => {
  it("normalizes symptoms (trim + lowercase) and defaults red_flags", () => {
    const parsed = triageInputSchema.parse({ symptoms: ["  Chest PAIN  "] });
    expect(parsed).toEqual({ symptoms: ["chest pain"], red_flags: [] });
  });

  it("rejects empty symptom lists", () => {
    expect(triageInputSchema.safeParse({ symptoms: [] }).success).toBe(false);
  });

  it("rejects more than 10 symptoms", () => {
    const symptoms = Array.from({ length: 11 }, (_, i) => `symptom ${i}`);
    expect(triageInputSchema.safeParse({ symptoms }).success).toBe(false);
  });

  it("rejects symptoms over 60 chars and blank symptoms", () => {
    expect(triageInputSchema.safeParse({ symptoms: ["x".repeat(61)] }).success).toBe(false);
    expect(triageInputSchema.safeParse({ symptoms: ["   "] }).success).toBe(false);
  });

  it("rejects unknown red flags", () => {
    expect(triageInputSchema.safeParse({ symptoms: ["cough"], red_flags: ["chest_pain"] }).success).toBe(false);
  });

  it("rejects out-of-range numeric facts", () => {
    expect(triageInputSchema.safeParse({ symptoms: ["cough"], severity_1_to_10: 0 }).success).toBe(false);
    expect(triageInputSchema.safeParse({ symptoms: ["cough"], severity_1_to_10: 5.5 }).success).toBe(false);
    expect(triageInputSchema.safeParse({ symptoms: ["cough"], duration_hours: 9000 }).success).toBe(false);
    expect(triageInputSchema.safeParse({ symptoms: ["cough"], age: 121 }).success).toBe(false);
  });
});

describe("chest pain rules", () => {
  it.each([
    "chest pain",
    "pain in my chest",
    "chest tightness",
    "chest pressure",
    "Tight Chest",
    "heaviness in the chest",
  ])('recognizes "%s" as chest pain', (symptom) => {
    expect(ruleIds({ symptoms: [symptom], age: 30 })).toEqual(["chest_pain"]);
  });

  it.each([
    "shortness_of_breath",
    "pain_radiating_arm_or_jaw",
    "sweating_or_nausea_with_pain",
    "fainting_or_near_fainting",
  ])("chest pain + %s is an emergency", (flag) => {
    const result = assess({ symptoms: ["chest pain"], red_flags: [flag] });
    expect(result.urgency).toBe("emergency");
    expect(result.mustCallEmergencyServices).toBe(true);
    expect(result.matchedRules.map((r) => r.id)).toEqual(["chest_pain_red_flags"]);
    expect(result.suggestedSpecialties).toEqual(["cardiology", "emergency_medicine"]);
  });

  it("chest pain + known heart disease is an emergency only when severity >= 7", () => {
    const severe = assess({ symptoms: ["chest pain"], red_flags: ["known_heart_disease"], severity_1_to_10: 7 });
    expect(severe.urgency).toBe("emergency");

    const mild = assess({ symptoms: ["chest pain"], red_flags: ["known_heart_disease"], severity_1_to_10: 4 });
    expect(mild.urgency).toBe("urgent");
    expect(mild.matchedRules.map((r) => r.id)).toEqual(["chest_pain_risk_factors"]);
  });

  it("chest pain with severity >= 7 or age >= 40 is urgent", () => {
    for (const extra of [{ severity_1_to_10: 7 }, { age: 40 }]) {
      const result = assess({ symptoms: ["chest pain"], ...extra });
      expect(result.urgency).toBe("urgent");
      expect(result.mustCallEmergencyServices).toBe(false);
      expect(result.suggestedSpecialties).toEqual(["cardiology", "emergency_medicine"]);
    }
  });

  it("chest pain alone in a young patient is routine, never self-care", () => {
    const result = assess({ symptoms: ["chest pain"], age: 25, severity_1_to_10: 2, duration_hours: 1 });
    expect(result.urgency).toBe("routine");
    expect(result.matchedRules.map((r) => r.id)).toEqual(["chest_pain"]);
    expect(result.suggestedSpecialties).toEqual(["cardiology", "general_practice"]);
  });

  it("does not treat unrelated words as chest pain", () => {
    expect(ruleIds({ symptoms: ["routine checkup", "chest x-ray scheduled"] })).toEqual(["fallback"]);
  });
});

describe("flag-driven rules", () => {
  it.each(["face_droop", "arm_weakness", "speech_difficulty", "sudden_severe_headache"])(
    "%s triggers the stroke rule",
    (flag) => {
      const result = assess({ symptoms: ["weakness"], red_flags: [flag] });
      expect(result.urgency).toBe("emergency");
      expect(result.matchedRules.map((r) => r.id)).toEqual(["stroke_signs"]);
      expect(result.suggestedSpecialties).toEqual(["neurology", "emergency_medicine"]);
    },
  );

  it.each([
    ["severe_bleeding", "severe_bleeding", ["emergency_medicine"]],
    ["difficulty_breathing", "difficulty_breathing", ["emergency_medicine", "pulmonology"]],
    ["suicidal_thoughts", "suicidal_thoughts", ["psychiatry", "emergency_medicine"]],
    ["high_fever_with_stiff_neck", "meningitis_signs", ["emergency_medicine", "neurology"]],
  ] as const)("%s is an emergency", (flag, ruleId, specialties) => {
    const result = assess({ symptoms: ["feeling unwell"], red_flags: [flag] });
    expect(result.urgency).toBe("emergency");
    expect(result.mustCallEmergencyServices).toBe(true);
    expect(result.matchedRules.map((r) => r.id)).toEqual([ruleId]);
    expect(result.suggestedSpecialties).toEqual(specialties);
  });

  it("severe abdominal pain during pregnancy is an emergency", () => {
    const result = assess({ symptoms: ["stomach pain"], red_flags: ["severe_abdominal_pain", "pregnancy"] });
    expect(result.urgency).toBe("emergency");
    expect(result.matchedRules.map((r) => r.id)).toEqual(["abdominal_pain_pregnancy"]);
  });

  it("severe abdominal pain alone is urgent", () => {
    const result = assess({ symptoms: ["stomach pain"], red_flags: ["severe_abdominal_pain"] });
    expect(result.urgency).toBe("urgent");
    expect(result.matchedRules.map((r) => r.id)).toEqual(["severe_abdominal_pain"]);
    expect(result.suggestedSpecialties).toEqual(["gastroenterology", "emergency_medicine"]);
  });

  it("vision loss is urgent (ophthalmology)", () => {
    const result = assess({ symptoms: ["blurry eye"], red_flags: ["vision_loss"] });
    expect(result.urgency).toBe("urgent");
    expect(result.matchedRules.map((r) => r.id)).toEqual(["vision_loss"]);
    expect(result.suggestedSpecialties).toEqual(["ophthalmology"]);
  });

  it("pregnancy or known heart disease alone do not raise urgency", () => {
    expect(assess({ symptoms: ["tiredness"], red_flags: ["pregnancy"] }).urgency).toBe("routine");
    expect(assess({ symptoms: ["tiredness"], red_flags: ["known_heart_disease"] }).urgency).toBe("routine");
  });
});

describe("symptom-driven rules", () => {
  it("headache is urgent when severity >= 8 or it lasts more than 72h", () => {
    expect(ruleIds({ symptoms: ["headache"], severity_1_to_10: 8 })).toEqual(["severe_or_persistent_headache"]);
    expect(ruleIds({ symptoms: ["pain in my head"], duration_hours: 73 })).toEqual(["severe_or_persistent_headache"]);
    expect(assess({ symptoms: ["migraine"], severity_1_to_10: 8 }).suggestedSpecialties).toEqual(["neurology"]);
  });

  it("a mild short headache is not urgent", () => {
    expect(assess({ symptoms: ["headache"], severity_1_to_10: 5, duration_hours: 72 }).urgency).toBe("routine");
  });

  it.each(["rash", "itchy skin", "a mole that changed colour", "hives on my arm"])(
    '"%s" routes to dermatology',
    (symptom) => {
      const result = assess({ symptoms: [symptom] });
      expect(result.urgency).toBe("routine");
      expect(result.matchedRules.map((r) => r.id)).toEqual(["skin_complaint"]);
      expect(result.suggestedSpecialties).toEqual(["dermatology"]);
    },
  );

  it("mild, short-lived symptoms with no flags are self-care", () => {
    const result = assess({ symptoms: ["runny nose"], severity_1_to_10: 3, duration_hours: 72 });
    expect(result.urgency).toBe("self_care");
    expect(result.matchedRules.map((r) => r.id)).toEqual(["mild_short_lived"]);
    expect(result.suggestedSpecialties).toEqual(["general_practice"]);
  });

  it("self-care requires both severity and duration to be known", () => {
    expect(assess({ symptoms: ["runny nose"], severity_1_to_10: 2 }).urgency).toBe("routine");
    expect(assess({ symptoms: ["runny nose"], duration_hours: 2 }).urgency).toBe("routine");
  });

  it("falls back to routine / general practice when nothing matches", () => {
    const result = assess({ symptoms: ["knee clicks when walking"], severity_1_to_10: 5 });
    expect(result).toEqual({
      urgency: "routine",
      mustCallEmergencyServices: false,
      matchedRules: [{ id: "fallback", description: expect.any(String) }],
      suggestedSpecialties: ["general_practice"],
    });
  });
});

describe("precedence and aggregation", () => {
  it("emergency beats routine when both match and only emergency rules are reported", () => {
    const result = assess({
      symptoms: ["rash", "chest pain"],
      red_flags: ["shortness_of_breath"],
      severity_1_to_10: 2,
      duration_hours: 1,
    });
    expect(result.urgency).toBe("emergency");
    expect(result.matchedRules.map((r) => r.id)).toEqual(["chest_pain_red_flags"]);
    expect(result.suggestedSpecialties).toEqual(["cardiology", "emergency_medicine"]);
  });

  it("urgent beats self-care and routine", () => {
    const result = assess({ symptoms: ["headache"], severity_1_to_10: 9, duration_hours: 1 });
    expect(result.urgency).toBe("urgent");
    expect(result.matchedRules.map((r) => r.id)).toEqual(["severe_or_persistent_headache"]);
  });

  it("unions and dedupes specialties across matched rules at the winning level, max 3", () => {
    const result = assess({
      symptoms: ["chest pain"],
      red_flags: ["shortness_of_breath", "face_droop", "suicidal_thoughts", "difficulty_breathing"],
    });
    expect(result.urgency).toBe("emergency");
    expect(result.matchedRules.map((r) => r.id)).toEqual([
      "chest_pain_red_flags",
      "stroke_signs",
      "difficulty_breathing",
      "suicidal_thoughts",
    ]);
    // cardiology, emergency_medicine (deduped), neurology -> cap reached.
    expect(result.suggestedSpecialties).toEqual(["cardiology", "emergency_medicine", "neurology"]);
  });

  it("is deterministic and does not mutate its input", () => {
    const input: TriageInput = { symptoms: ["chest pain"], red_flags: ["shortness_of_breath"], age: 50 };
    const snapshot = structuredClone(input);
    expect(assessUrgency(input)).toEqual(assessUrgency(input));
    expect(input).toEqual(snapshot);
  });

  it("rule ids are unique", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
