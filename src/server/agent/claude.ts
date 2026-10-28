/**
 * Anthropic client factory and model-provider credential modes.
 *
 * The loop depends on `ClaudeClient`, the narrowest structural slice of the
 * SDK client it actually uses, so tests can inject a scripted fake without
 * touching the network. `asClaudeClient` is the compile-time proof that the
 * real client satisfies that slice.
 *
 * Three ways to reach a model (docs/DECISIONS.md ADR-8), chosen from the
 * environment in this order:
 *
 * 1. `anthropic`    - ANTHROPIC_API_KEY set: the Anthropic API directly.
 * 2. `gateway-key`  - AI_GATEWAY_API_KEY set: Vercel AI Gateway with a key.
 * 3. `gateway-oidc` - neither key, but running on Vercel: AI Gateway with the
 *                     deployment's short-lived OIDC token as the bearer token.
 *
 * Otherwise the mode is `unconfigured` and the assistant refuses to run.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { getVercelOidcToken } from "@vercel/functions/oidc";
import { ConfigError, getConfig, loadConfig, type Config } from "@/server/config";

/** What the loop needs from a stream: text events while running, the full message at the end. */
export type ClaudeMessageStream = AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> & {
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
};

/** Re-exported so callers never import SDK subpaths themselves. */
export type ClaudeStreamParams = BetaMessageStreamParams;

export type ClaudeStreamOptions = { signal?: AbortSignal };

export type ClaudeClient = {
  beta: {
    messages: {
      stream: (params: BetaMessageStreamParams, options?: ClaudeStreamOptions) => ClaudeMessageStream;
    };
  };
};

/** Compile-time assertion that the SDK client is structurally a `ClaudeClient`. */
function asClaudeClient(client: Anthropic): ClaudeClient {
  return client;
}

// ---------------------------------------------------------------------------
// Provider modes
// ---------------------------------------------------------------------------

export type ProviderMode = "anthropic" | "gateway-key" | "gateway-oidc" | "unconfigured";

/**
 * Everything the loop and the health endpoint need to know about the provider.
 * Deliberately carries no credential: it is logged and returned by /api/health.
 */
export type ProviderProfile = {
  mode: ProviderMode;
  /** Set for the gateway modes; the SDK default (api.anthropic.com) otherwise. */
  baseURL?: string;
  /** Effective model id: the Anthropic id directly, or a `provider/model` slug through the gateway. */
  model: string;
  /**
   * Send `betas` + `fallbacks: "default"` (server-side safety fallbacks). Only
   * against the Anthropic API: the gateway's support for those parameters is
   * unknown, so they are omitted there rather than risking a rejected request.
   */
  useServerFallbacks: boolean;
};

export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

/**
 * Gateway model ids are `provider/model` slugs with dots in the version
 * (`anthropic/claude-opus-5.5`), while the Anthropic API uses dashes. The
 * explicit table covers the ids this project documents; anything else is
 * derived by `toGatewayModelId`.
 */
export const GATEWAY_MODEL_SLUGS: Readonly<Record<string, string>> = {
  "claude-opus-5-5": "anthropic/claude-opus-5.5",
  "claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
  "claude-haiku-5-5": "anthropic/claude-haiku-5.5",
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
};

/**
 * Maps an Anthropic model id to the gateway slug. An id that already contains
 * a slash is taken as a gateway slug verbatim (`CLAUDE_MODEL=anthropic/...`).
 * Unknown ids get the `anthropic/` prefix, and only a trailing `-MAJOR-MINOR`
 * is rewritten to `-MAJOR.MINOR` (`claude-opus-4-8` -> `anthropic/claude-opus-4.8`);
 * `claude-opus-5` has no minor version and is left alone.
 */
export function toGatewayModelId(modelId: string): string {
  if (modelId.includes("/")) return modelId;
  const known = GATEWAY_MODEL_SLUGS[modelId];
  if (known) return known;
  const slug = /-\d+-\d+$/.test(modelId) ? modelId.replace(/-(\d+)$/, ".$1") : modelId;
  return `anthropic/${slug}`;
}

/** Pure: the profile for an already-parsed configuration. */
export function resolveProviderProfile(config: Config): ProviderProfile {
  if (config.anthropicApiKey) {
    return { mode: "anthropic", model: config.claudeModel, useServerFallbacks: true };
  }
  const gateway = {
    baseURL: AI_GATEWAY_BASE_URL,
    model: toGatewayModelId(config.claudeModel),
    useServerFallbacks: false,
  };
  if (config.aiGatewayApiKey) return { mode: "gateway-key", ...gateway };
  if (config.onVercel) return { mode: "gateway-oidc", ...gateway };
  return { mode: "unconfigured", model: config.claudeModel, useServerFallbacks: false };
}

/**
 * Pure: the provider mode for an environment map (`process.env` or a test
 * object). Throws `ConfigError` for an invalid environment, like `loadConfig`.
 */
export function resolveProviderMode(env: Record<string, string | undefined>): ProviderProfile {
  return resolveProviderProfile(loadConfig(env));
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** Explicit key for tests/scripts; otherwise the SDK reads ANTHROPIC_API_KEY itself. */
export function createClaudeClient(apiKey?: string): ClaudeClient {
  return asClaudeClient(new Anthropic(apiKey ? { apiKey } : undefined));
}

/**
 * Builds the SDK client for a mode. Always returns a fresh instance: in
 * `gateway-oidc` mode the bearer token is short-lived and resolved here, so
 * callers must create the client per turn and never cache it across tokens
 * (the key modes are safe to cache). Throws `ConfigError`, never an SDK error,
 * when the mode cannot be served from `config`.
 */
export async function createClaudeClientForMode(
  mode: ProviderMode,
  config: Config = getConfig(),
): Promise<ClaudeClient> {
  switch (mode) {
    case "anthropic": {
      if (!config.anthropicApiKey) throw new ConfigError("ANTHROPIC_API_KEY is not set");
      return createClaudeClient(config.anthropicApiKey);
    }
    case "gateway-key": {
      if (!config.aiGatewayApiKey) throw new ConfigError("AI_GATEWAY_API_KEY is not set");
      return asClaudeClient(new Anthropic({ baseURL: AI_GATEWAY_BASE_URL, apiKey: config.aiGatewayApiKey }));
    }
    case "gateway-oidc": {
      if (!config.onVercel) throw new ConfigError("Gateway OIDC mode is only available on Vercel");
      let token: string;
      try {
        token = await getVercelOidcToken();
      } catch (err) {
        // The cause is operator information (missing OIDC federation, expired
        // local token); the message never includes a token.
        throw new ConfigError(`Vercel OIDC token unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      // `apiKey: null` keeps the SDK from reading ANTHROPIC_API_KEY; the token goes out as `Authorization: Bearer`.
      return asClaudeClient(new Anthropic({ baseURL: AI_GATEWAY_BASE_URL, authToken: token, apiKey: null }));
    }
    case "unconfigured":
      throw new ConfigError(
        "No model credentials: set ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY, or deploy on Vercel with OIDC",
      );
  }
}

let singleton: ClaudeClient | undefined;

/** Lazy per-process direct-API client. Throws `ConfigError` (not an SDK error) when the key is missing. */
export function getClaudeClient(): ClaudeClient {
  if (!singleton) {
    const { anthropicApiKey } = getConfig();
    if (!anthropicApiKey) {
      throw new ConfigError("ANTHROPIC_API_KEY is not set; the AI assistant cannot run");
    }
    singleton = createClaudeClient(anthropicApiKey);
  }
  return singleton;
}
