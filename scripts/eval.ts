/**
 * Scripted end-to-end evaluation of the agent against the real model.
 *
 *   npm run eval                       (all scenarios, readable transcript)
 *   npm run eval -- --only <id> [...]  (subset; ids from scripts/scenarios.ts)
 *   npm run eval -- --json             (machine-readable report on stdout)
 *
 * Exit codes: 0 all scenarios passed, 1 at least one failed, 2 usage/config.
 *
 * Runs the production loop (`runTurn`) unchanged against the in-memory
 * repository, so what is exercised here is exactly what the HTTP route runs,
 * minus the HTTP layer. The loop's own structured logs (`agent.step`) are
 * sent to stderr so stdout stays a clean transcript (or clean JSON).
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import type { AgentEvent, Locale, ProviderSummary, Recommendation } from "@/shared/contracts";
import { getConfig } from "@/server/config";
import { createClaudeClient, runTurn } from "@/server/agent";
import { GroundingSet } from "@/server/agent/grounding";
import { createMemoryRepositories } from "@/server/repositories/memory";
import type { Repositories } from "@/server/repositories/types";
import { SCENARIOS, type Scenario } from "./scenarios";

/** Opening message plus at most three scripted answers. */
const MAX_ROUNDS = 4;
/** A single turn can take several model calls; this only guards against a hung connection. */
const TURN_TIMEOUT_MS = 180_000;
/** Tool inputs can carry a 1200-character rationale; keep transcript lines scannable. */
const MAX_INPUT_PREVIEW = 400;

type DoneEvent = Extract<AgentEvent, { type: "done" }>;
type ErrorEvent = Extract<AgentEvent, { type: "error" }>;
type Usage = DoneEvent["usage"];

type ToolCallRecord = { id: string; name: string; input: unknown; ok: boolean; summary: string };

type TranscriptEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCallRecord[] };

type ScenarioResult = {
  id: string;
  locale: Locale;
  pass: boolean;
  reasons: string[];
  rounds: number;
  latencyMs: number;
  usage: Usage;
  recommendation: Recommendation | null;
  error: ErrorEvent | null;
  transcript: TranscriptEntry[];
};

type CliOptions = { only: string[]; json: boolean };

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Readable transcript writer; a no-op in --json mode so stdout holds only the report. */
type Printer = (text: string) => void;

const previewInput = (input: unknown): string => {
  const json = JSON.stringify(input) ?? String(input);
  return json.length > MAX_INPUT_PREVIEW ? `${json.slice(0, MAX_INPUT_PREVIEW)}…` : json;
};

const formatUsage = (u: Usage): string =>
  `in ${u.inputTokens} / out ${u.outputTokens} / cache read ${u.cacheReadInputTokens}`;

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const providerLabel = (p: ProviderSummary): string => `${p.nameEn} (${p.city}, ${p.id.slice(0, 8)})`;

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
});

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };

// ---------------------------------------------------------------------------
// One round (= one user message = one runTurn)
// ---------------------------------------------------------------------------

type RoundOutcome = {
  text: string;
  toolCalls: ToolCallRecord[];
  recommendation: Recommendation | null;
  terminal: DoneEvent | ErrorEvent;
};

async function runRound(
  deps: { repos: Repositories; client: ReturnType<typeof createClaudeClient>; print: Printer },
  scenario: Scenario,
  conversationId: string,
  userText: string,
): Promise<RoundOutcome> {
  const { repos, client, print } = deps;
  const config = getConfig();
  const toolCalls: ToolCallRecord[] = [];
  let text = "";
  let recommendation: Recommendation | null = null;
  let terminal: DoneEvent | ErrorEvent | null = null;
  // Text streams in deltas; tool lines interrupt it, so track whether we owe a prefix.
  let atLineStart = true;

  print(`user> ${userText}\n`);

  const events = runTurn({
    conversationId,
    userText,
    locale: scenario.locale,
    deps: {
      repos,
      client,
      model: config.claudeModel,
      effort: config.claudeEffort,
      maxSteps: config.agentMaxSteps,
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    },
  });

  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        if (atLineStart) {
          print("assistant> ");
          atLineStart = false;
        }
        print(event.text);
        text += event.text;
        break;
      case "tool_call":
        if (!atLineStart) print("\n");
        atLineStart = true;
        toolCalls.push({ id: event.id, name: event.name, input: event.input, ok: false, summary: "" });
        break;
      case "tool_result": {
        const call = toolCalls.find((c) => c.id === event.id);
        if (call) {
          call.ok = event.ok;
          call.summary = event.summary;
        }
        const marker = event.ok ? "=>" : "=> ERROR:";
        print(`  -> ${event.name}(${previewInput(call?.input)}) ${marker} ${event.summary}\n`);
        break;
      }
      case "recommendation": {
        const r = event.recommendation;
        recommendation = r;
        const providers = r.providers.length === 0 ? "none" : r.providers.map(providerLabel).join("; ");
        print(
          `  [recommendation] ${r.nextStep} | ${r.urgency} | specialty: ${r.specialty ?? "none"} | ` +
            `providers: ${providers}\n`,
        );
        break;
      }
      case "done":
        if (!atLineStart) print("\n");
        atLineStart = true;
        terminal = event;
        print(`  [done] ${event.stopReason} | ${formatUsage(event.usage)}\n`);
        break;
      case "error":
        if (!atLineStart) print("\n");
        atLineStart = true;
        terminal = event;
        print(`  [error] ${event.code}: ${event.message}${event.retryable ? " (retryable)" : ""}\n`);
        break;
      case "conversation":
        // Emitted by the HTTP layer only; the loop never yields it.
        break;
    }
  }

  if (!terminal) {
    // runTurn guarantees a terminal event; treat a violation as an error rather than crashing the run.
    terminal = { type: "error", code: "internal_error", message: "turn ended without a terminal event", retryable: false };
    print(`  [error] ${terminal.message}\n`);
  }
  return { text, toolCalls, recommendation, terminal };
}

// ---------------------------------------------------------------------------
// Grounding checks
// ---------------------------------------------------------------------------

const recommendInputSchema = z.object({ provider_ids: z.array(z.string()) });

/**
 * Words that appear in many provider names or in generic references ("the
 * nearest Hospital"); on their own they do not identify a provider.
 */
const GENERIC_NAME_WORDS = new Set([
  "dr", "hospital", "clinic", "center", "centre", "medical", "city", "klinikum", "&", "and", "the",
  "a", "an", "general", "university", "specialist", "emergency", "department", "unit", "nearest",
  "nearby", "local", "public", "private", "any", "your", "a&e",
]);

/**
 * "Dr. Elif Kaya", "Bosphorus Heart & Vascular Hospital", "د. إيليف".
 * Arabic has no capitalisation to mark where a name ends, so only the word
 * right after "د." is captured; a given name or surname is enough to decide.
 */
const NAME_PATTERNS: readonly RegExp[] = [
  /\bDr\.?\s+([A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*){0,2})/gu,
  /\b((?:(?:[A-Z][\p{L}'’-]*|&)\s+){1,5}(?:Hospital|Clinic|Center|Centre|Klinikum|Medical City))\b/gu,
  /د\.\s*(\p{Script=Arabic}+)/gu,
];

const normalizeWord = (word: string): string =>
  word
    .toLowerCase()
    .replace(/^[("'“‘]+|[.,;:!?)"'”’]+$/gu, "")
    .replace(/['’]s$/u, "");

const significantWords = (phrase: string): string[] =>
  phrase
    .split(/\s+/u)
    .map(normalizeWord)
    .filter((w) => w.length > 0 && !GENERIC_NAME_WORDS.has(w));

const containsSequence = (words: readonly string[], seq: readonly string[]): boolean =>
  words.some((_, i) => seq.every((w, j) => words[i + j] === w));

/**
 * Heuristic: every doctor/facility-looking name in the assistant's prose must
 * come from a provider the model actually fetched through tools in this
 * conversation. A candidate is grounded when all of its words belong to
 * grounded names (covers "Dr. Kaya") or when it contains a full grounded name
 * (covers a capitalised sentence-start word before the name, e.g.
 * "Alternatively Spree Klinikum"). Catches both invented names and seed names
 * the model may have memorised but never looked up. Arabic prose is only
 * checked for "د. <name>" because facility phrases there have no
 * capitalisation signal.
 */
function findUngroundedNames(text: string, grounded: readonly ProviderSummary[]): string[] {
  const groundedNames = grounded
    .flatMap((p) => [significantWords(p.nameEn), significantWords(p.nameAr)])
    .filter((words) => words.length > 0);
  const groundedWords = new Set(groundedNames.flat());
  const isGrounded = (words: readonly string[]): boolean =>
    words.every((w) => groundedWords.has(w)) || groundedNames.some((name) => containsSequence(words, name));

  const flagged = new Set<string>();
  for (const pattern of NAME_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1];
      if (candidate === undefined) continue;
      const words = significantWords(candidate);
      if (words.length > 0 && !isGrounded(words)) flagged.add(match[0].trim());
    }
  }
  return [...flagged];
}

/**
 * Checks that are independent of the scenario's expectations: a stored
 * recommendation may only point at providers that exist in the repository,
 * and the accepted tool input must not have carried ids that silently failed
 * to hydrate.
 */
async function checkGrounding(
  repos: Repositories,
  conversationId: string,
  result: Pick<ScenarioResult, "recommendation" | "transcript">,
  checkNames: boolean,
): Promise<string[]> {
  const reasons: string[] = [];
  const { recommendation } = result;
  if (recommendation) {
    for (const p of recommendation.providers) {
      if ((await repos.providers.getById(p.id)) === null) {
        reasons.push(`recommended provider ${p.id} does not exist in the repository`);
      }
    }
    const accepted = result.transcript
      .flatMap((m) => (m.role === "assistant" ? m.toolCalls : []))
      .filter((c) => c.name === "recommend_next_step" && c.ok)
      .at(-1);
    const parsed = accepted ? recommendInputSchema.safeParse(accepted.input) : undefined;
    if (parsed?.success) {
      const requested = new Set(parsed.data.provider_ids);
      if (requested.size !== recommendation.providers.length) {
        reasons.push(
          `recommend_next_step sent ${requested.size} provider id(s) but ${recommendation.providers.length} hydrated`,
        );
      }
    }
  }

  if (checkNames) {
    const grounding = GroundingSet.fromToolCalls(await repos.conversations.listToolCalls(conversationId));
    const grounded = await repos.providers.getManyByIds(grounding.allowedIds());
    const prose = result.transcript
      .map((m) => (m.role === "assistant" ? m.text : ""))
      .concat(recommendation?.rationale ?? "")
      .join("\n");
    const ungrounded = findUngroundedNames(prose, grounded);
    if (ungrounded.length > 0) {
      reasons.push(`assistant named provider(s) not returned by any tool: ${ungrounded.map((n) => `"${n}"`).join(", ")}`);
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

function evaluateExpectations(scenario: Scenario, result: Pick<ScenarioResult, "recommendation" | "error" | "rounds">): string[] {
  const { expect } = scenario;
  const rec = result.recommendation;
  if (!rec) {
    const why = result.error ? `turn ended with error ${result.error.code}: ${result.error.message}` : "agent kept asking questions";
    return [`no recommendation after ${result.rounds} round(s): ${why}`];
  }
  const reasons: string[] = [];
  const inSet = <T extends string>(label: string, value: T | null, allowed: readonly T[] | undefined) => {
    if (allowed && (value === null || !allowed.includes(value))) {
      reasons.push(`${label} "${value ?? "null"}" not in [${allowed.join(", ")}]`);
    }
  };
  inSet("nextStep", rec.nextStep, expect.nextStep);
  inSet("urgency", rec.urgency, expect.urgency);
  inSet("specialty", rec.specialty, expect.specialty);
  const count = rec.providers.length;
  if (expect.minProviders !== undefined && count < expect.minProviders) {
    reasons.push(`expected at least ${expect.minProviders} provider(s), got ${count}`);
  }
  if (expect.maxProviders !== undefined && count > expect.maxProviders) {
    reasons.push(`expected at most ${expect.maxProviders} provider(s), got ${count}`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Scenario driver
// ---------------------------------------------------------------------------

async function runScenario(
  deps: { repos: Repositories; client: ReturnType<typeof createClaudeClient>; print: Printer },
  scenario: Scenario,
): Promise<ScenarioResult> {
  const { repos, print } = deps;
  print(`\n=== ${scenario.id} (${scenario.locale}) ===\n`);
  const startedAt = Date.now();
  const conversation = await repos.conversations.create(scenario.locale);
  const transcript: TranscriptEntry[] = [];
  let usage = ZERO_USAGE;
  let recommendation: Recommendation | null = null;
  let error: ErrorEvent | null = null;
  let rounds = 0;
  const reasons: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const userText = round === 0 ? scenario.opening : scenario.answers[round - 1];
    if (userText === undefined) {
      reasons.push(`agent asked more questions than the ${scenario.answers.length} scripted answer(s)`);
      break;
    }
    rounds += 1;
    transcript.push({ role: "user", text: userText });
    const outcome = await runRound(deps, scenario, conversation.id, userText);
    transcript.push({ role: "assistant", text: outcome.text, toolCalls: outcome.toolCalls });
    if (outcome.terminal.type === "done") {
      usage = addUsage(usage, outcome.terminal.usage);
    } else {
      error = outcome.terminal;
      break;
    }
    if (outcome.recommendation) {
      recommendation = outcome.recommendation;
      break;
    }
  }
  if (rounds === MAX_ROUNDS && !recommendation && !error) {
    reasons.push(`no recommendation within ${MAX_ROUNDS} rounds`);
  }

  const partial = { recommendation, error, rounds, transcript };
  reasons.push(...evaluateExpectations(scenario, partial));
  reasons.push(...(await checkGrounding(repos, conversation.id, partial, scenario.expect.noProviderNamesOutsideDb === true)));

  const rejected = transcript
    .flatMap((m) => (m.role === "assistant" ? m.toolCalls : []))
    .filter((c) => c.name === "recommend_next_step" && !c.ok).length;

  const latencyMs = Date.now() - startedAt;
  const pass = reasons.length === 0;
  print(
    `${pass ? "PASS" : "FAIL"} ${scenario.id} (${rounds} round(s), ${formatSeconds(latencyMs)}, tokens ${formatUsage(usage)}` +
      `${rejected > 0 ? `, ${rejected} recommendation(s) rejected by validation` : ""})\n`,
  );
  for (const reason of reasons) print(`  - ${reason}\n`);

  return {
    id: scenario.id,
    locale: scenario.locale,
    pass,
    reasons,
    rounds,
    latencyMs,
    usage,
    recommendation,
    error,
    transcript,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: npm run eval -- [--only <scenario-id>]... [--json]

Scenarios: ${SCENARIOS.map((s) => s.id).join(", ")}
Requires ANTHROPIC_API_KEY (via .env or the environment). Uses the in-memory repository.`;

function parseCli(argv: string[]): CliOptions | null {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        only: { type: "string", multiple: true },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });
    if (values.help) return null;
    const only = (values.only ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
    return { only, json: values.json === true };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function main(): Promise<number> {
  const options = parseCli(process.argv.slice(2));
  if (!options) {
    console.error(USAGE);
    return 2;
  }

  const config = getConfig();
  if (!config.anthropicApiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example) or export it, then re-run npm run eval.");
    return 2;
  }

  const unknown = options.only.filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length > 0) {
    console.error(`Unknown scenario id(s): ${unknown.join(", ")}\n\n${USAGE}`);
    return 2;
  }
  const selected = options.only.length > 0 ? SCENARIOS.filter((s) => options.only.includes(s.id)) : SCENARIOS;

  // The loop logs one JSON line per model call via console.info; keep stdout for the transcript/report.
  console.info = (...args: unknown[]) => console.error(...args);

  const print: Printer = options.json ? () => undefined : (text) => process.stdout.write(text);
  const repos = createMemoryRepositories();
  const client = createClaudeClient(config.anthropicApiKey);
  const deps = { repos, client, print };

  print(
    `HealTrip eval: model ${config.claudeModel}, effort ${config.claudeEffort}, max steps ${config.agentMaxSteps}, ` +
      `${selected.length} scenario(s), ${repos.kind} repository\n`,
  );

  const startedAt = Date.now();
  const results: ScenarioResult[] = [];
  for (const scenario of selected) results.push(await runScenario(deps, scenario));

  const passed = results.filter((r) => r.pass).length;
  const total = results.reduce((acc, r) => addUsage(acc, r.usage), ZERO_USAGE);
  const elapsedMs = Date.now() - startedAt;

  if (options.json) {
    const report = {
      model: config.claudeModel,
      effort: config.claudeEffort,
      maxSteps: config.agentMaxSteps,
      passed,
      total: results.length,
      usage: total,
      elapsedMs,
      scenarios: results,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    print(`\nSummary: ${passed}/${results.length} passed; tokens ${formatUsage(total)}; ${formatSeconds(elapsedMs)}\n`);
    for (const r of results.filter((x) => !x.pass)) print(`  FAIL ${r.id}: ${r.reasons.join("; ")}\n`);
  }
  return passed === results.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error("eval crashed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
