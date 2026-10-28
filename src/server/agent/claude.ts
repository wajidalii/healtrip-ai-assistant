/**
 * Anthropic client factory.
 *
 * The loop depends on `ClaudeClient`, the narrowest structural slice of the
 * SDK client it actually uses, so tests can inject a scripted fake without
 * touching the network. `asClaudeClient` is the compile-time proof that the
 * real client satisfies that slice.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ConfigError, getConfig } from "@/server/config";

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

/** Explicit key for tests/scripts; otherwise the SDK reads ANTHROPIC_API_KEY itself. */
export function createClaudeClient(apiKey?: string): ClaudeClient {
  return asClaudeClient(new Anthropic(apiKey ? { apiKey } : undefined));
}

let singleton: ClaudeClient | undefined;

/** Lazy per-process client. Throws `ConfigError` (not an SDK error) when the key is missing. */
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
