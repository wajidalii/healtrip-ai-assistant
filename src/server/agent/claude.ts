/**
 * Anthropic client factory. The loop depends on the `ClaudeClient` type (the
 * real SDK client) so tests can inject a structurally compatible fake.
 *
 * NOTE: stub; issue #5 completes it (lazy singleton, missing-key handling).
 */
import Anthropic from "@anthropic-ai/sdk";

export type ClaudeClient = Pick<Anthropic, "beta">;

export function createClaudeClient(apiKey?: string): ClaudeClient {
  return new Anthropic(apiKey ? { apiKey } : undefined);
}
