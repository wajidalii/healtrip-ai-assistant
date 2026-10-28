/**
 * Deterministic urgency assessment. Pure function: no I/O, no clock, no
 * randomness, so the same facts always yield the same urgency (the whole
 * point of not letting the model decide; see docs/AGENT.md).
 */
import { z } from "zod";
import { RED_FLAGS, URGENCY_LEVELS, type RedFlag, type Specialty, type Urgency } from "@/shared/contracts";
import { FALLBACK_RULE, RULES, type Concept, type Rule, type TriageFacts } from "@/server/triage/rules";

export const triageInputSchema = z.object({
  symptoms: z.array(z.string().trim().toLowerCase().min(1).max(60)).min(1).max(10),
  red_flags: z.array(z.enum(RED_FLAGS)).default([]),
  duration_hours: z.number().min(0).max(8760).optional(),
  severity_1_to_10: z.number().int().min(1).max(10).optional(),
  age: z.number().int().min(0).max(120).optional(),
});
export type TriageInput = z.infer<typeof triageInputSchema>;

export type TriageResult = {
  urgency: Urgency;
  mustCallEmergencyServices: boolean;
  matchedRules: { id: string; description: string }[];
  suggestedSpecialties: Specialty[];
};

const MAX_SPECIALTIES = 3;

/** Lower index in URGENCY_LEVELS means more urgent. */
const rank = (urgency: Urgency): number => URGENCY_LEVELS.indexOf(urgency);

function buildFacts(input: TriageInput): TriageFacts {
  const flags = new Set<RedFlag>(input.red_flags);
  const matchesOne = (symptom: string, matcher: RegExp | string): boolean =>
    typeof matcher === "string" ? symptom.includes(matcher.toLowerCase()) : matcher.test(symptom);
  return {
    hasSymptom: (matcher: Concept | RegExp | string) => {
      const patterns: readonly (RegExp | string)[] = Array.isArray(matcher) ? matcher : [matcher];
      return input.symptoms.some((s) => patterns.some((p) => matchesOne(s, p)));
    },
    hasFlag: (flag) => flags.has(flag),
    hasAnyFlag: (candidates) =>
      candidates === undefined ? flags.size > 0 : candidates.some((f) => flags.has(f)),
    severity: input.severity_1_to_10,
    durationHours: input.duration_hours,
    age: input.age,
  };
}

/** Unions specialties in first-appearance order, deduped, capped. */
function collectSpecialties(rules: readonly Rule[]): Specialty[] {
  const seen = new Set<Specialty>();
  for (const rule of rules) {
    for (const s of rule.specialties) {
      if (seen.size === MAX_SPECIALTIES) return [...seen];
      seen.add(s);
    }
  }
  return [...seen];
}

export function assessUrgency(input: TriageInput): TriageResult {
  const facts = buildFacts(input);
  const matched = RULES.filter((rule) => rule.when(facts));

  // Highest urgency wins; only rules at that level explain the result.
  const winning = matched.length === 0 ? [FALLBACK_RULE] : pickHighestLevel(matched);
  const urgency = winning[0].urgency;

  return {
    urgency,
    mustCallEmergencyServices: urgency === "emergency",
    matchedRules: winning.map(({ id, description }) => ({ id, description })),
    suggestedSpecialties: collectSpecialties(winning),
  };
}

function pickHighestLevel(matched: readonly Rule[]): Rule[] {
  const best = Math.min(...matched.map((r) => rank(r.urgency)));
  return matched.filter((r) => rank(r.urgency) === best);
}
