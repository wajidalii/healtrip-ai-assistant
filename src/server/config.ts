/**
 * Typed, server-only configuration parsed from environment variables.
 *
 * Parsing is lazy (`getConfig()`) so that importing any server module in tests
 * never throws because of a missing variable; `loadConfig(env)` lets tests pass
 * an explicit environment.
 */
import { z } from "zod";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** `.env.example` ships `KEY=` lines; treat empty strings as "not set". */
const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const configSchema = z.object({
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  AI_GATEWAY_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Set by the Vercel runtime ("1"); any non-empty value counts (docs/DECISIONS.md ADR-8). */
  VERCEL: z.preprocess(emptyToUndefined, z.string().optional()),
  CLAUDE_MODEL: z.preprocess(emptyToUndefined, z.string().default("claude-opus-5-5")),
  CLAUDE_EFFORT: z.preprocess(emptyToUndefined, z.enum(CLAUDE_EFFORTS).default("low")),
  AGENT_MAX_STEPS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(10).default(6),
  ),
  DATABASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  RATE_LIMIT_PER_MINUTE: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).default(20),
  ),
});

export type Config = {
  anthropicApiKey: string | undefined;
  /** Vercel AI Gateway key; used only when `anthropicApiKey` is unset. */
  aiGatewayApiKey: string | undefined;
  /** True when running on Vercel, where an OIDC token can stand in for a key. */
  onVercel: boolean;
  claudeModel: string;
  claudeEffort: ClaudeEffort;
  agentMaxSteps: number;
  databaseUrl: string | undefined;
  rateLimitPerMinute: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parses an environment map. Throws `ConfigError` listing every invalid variable. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment configuration: ${problems}`);
  }
  const { data } = parsed;
  return {
    anthropicApiKey: data.ANTHROPIC_API_KEY,
    aiGatewayApiKey: data.AI_GATEWAY_API_KEY,
    onVercel: data.VERCEL !== undefined,
    claudeModel: data.CLAUDE_MODEL,
    claudeEffort: data.CLAUDE_EFFORT,
    agentMaxSteps: data.AGENT_MAX_STEPS,
    databaseUrl: data.DATABASE_URL,
    rateLimitPerMinute: data.RATE_LIMIT_PER_MINUTE,
  };
}

let cached: Config | undefined;

/** Lazily parses `process.env` once per process. */
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}
