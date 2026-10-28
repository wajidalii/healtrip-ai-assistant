/**
 * Credential modes for the model provider (docs/DECISIONS.md ADR-8):
 * mode resolution is a pure function of the environment, the client factory
 * builds the right SDK client per mode, and the loop drops the Anthropic-only
 * `betas`/`fallbacks` parameters through the gateway.
 */
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "@/server/config";
import {
  AI_GATEWAY_BASE_URL,
  createClaudeClient,
  createClaudeClientForMode,
  resolveProviderMode,
  resolveProviderProfile,
  toGatewayModelId,
  type ProviderProfile,
} from "@/server/agent/claude";
import { runTurn } from "@/server/agent/run-turn";
import { createMemoryRepositories } from "@/server/repositories/memory";
import { createFakeClaude, textTurn } from "./helpers/fake-claude";

const { getVercelOidcToken } = vi.hoisted(() => ({ getVercelOidcToken: vi.fn<() => Promise<string>>() }));
vi.mock("@vercel/functions/oidc", () => ({ getVercelOidcToken }));

/** The SDK client as the tests inspect it; the loop only ever sees `ClaudeClient`. */
const asSdk = (client: unknown): Anthropic => {
  if (!(client instanceof Anthropic)) throw new Error("expected an Anthropic SDK client");
  return client;
};

const ANTHROPIC_BASE = "https://api.anthropic.com";

describe("resolveProviderMode", () => {
  it("is `anthropic` with the plain model id and server fallbacks when ANTHROPIC_API_KEY is set", () => {
    expect(resolveProviderMode({ ANTHROPIC_API_KEY: "sk-ant-x" })).toEqual<ProviderProfile>({
      mode: "anthropic",
      model: "claude-opus-5-5",
      useServerFallbacks: true,
    });
  });

  it("is `openai` with the OpenAI model id and no server fallbacks when OPENAI_API_KEY is set", () => {
    expect(resolveProviderMode({ OPENAI_API_KEY: "sk-openai-x" })).toEqual<ProviderProfile>({
      mode: "openai",
      model: "gpt-6.1-sol",
      useServerFallbacks: false,
    });
    expect(resolveProviderMode({ OPENAI_API_KEY: "sk", OPENAI_MODEL: "gpt-6-luna" }).model).toBe("gpt-6-luna");
  });

  it("is `gateway-key` with the gateway base URL and slug when only AI_GATEWAY_API_KEY is set", () => {
    expect(resolveProviderMode({ AI_GATEWAY_API_KEY: "vck_x" })).toEqual<ProviderProfile>({
      mode: "gateway-key",
      baseURL: AI_GATEWAY_BASE_URL,
      model: "anthropic/claude-opus-5.5",
      useServerFallbacks: false,
    });
  });

  it("is `gateway-oidc` on Vercel when neither key is set", () => {
    expect(resolveProviderMode({ VERCEL: "1" })).toEqual<ProviderProfile>({
      mode: "gateway-oidc",
      baseURL: AI_GATEWAY_BASE_URL,
      model: "anthropic/claude-opus-5.5",
      useServerFallbacks: false,
    });
  });

  it("is `unconfigured` without keys off Vercel, and never enables fallbacks there", () => {
    expect(resolveProviderMode({})).toEqual<ProviderProfile>({
      mode: "unconfigured",
      model: "claude-opus-5-5",
      useServerFallbacks: false,
    });
  });

  it("prefers Anthropic over OpenAI, OpenAI over the gateway key, and the gateway key over OIDC", () => {
    const all = { ANTHROPIC_API_KEY: "sk", OPENAI_API_KEY: "sk-o", AI_GATEWAY_API_KEY: "vck", VERCEL: "1" };
    expect(resolveProviderMode(all).mode).toBe("anthropic");
    expect(resolveProviderMode({ OPENAI_API_KEY: "sk-o", AI_GATEWAY_API_KEY: "vck", VERCEL: "1" }).mode).toBe("openai");
    expect(resolveProviderMode({ AI_GATEWAY_API_KEY: "vck", VERCEL: "1" }).mode).toBe("gateway-key");
  });

  it("treats empty strings (as shipped in .env.example) as unset", () => {
    expect(resolveProviderMode({ ANTHROPIC_API_KEY: "", AI_GATEWAY_API_KEY: " ", VERCEL: "" }).mode).toBe("unconfigured");
    expect(resolveProviderMode({ ANTHROPIC_API_KEY: "", VERCEL: "1" }).mode).toBe("gateway-oidc");
  });

  it("maps CLAUDE_MODEL through the slug table only in the gateway modes", () => {
    expect(resolveProviderMode({ ANTHROPIC_API_KEY: "sk", CLAUDE_MODEL: "claude-sonnet-5-5" }).model).toBe("claude-sonnet-5-5");
    expect(resolveProviderMode({ AI_GATEWAY_API_KEY: "vck", CLAUDE_MODEL: "claude-sonnet-5-5" }).model).toBe(
      "anthropic/claude-sonnet-5.5",
    );
    expect(resolveProviderMode({ VERCEL: "1", CLAUDE_MODEL: "anthropic/claude-opus-5" }).model).toBe("anthropic/claude-opus-5");
  });

  it("carries no credential, so it is safe for /api/health and logs", () => {
    const profile = resolveProviderMode({ ANTHROPIC_API_KEY: "sk-ant-secret", AI_GATEWAY_API_KEY: "vck-secret" });
    expect(Object.keys(profile).sort()).toEqual(["mode", "model", "useServerFallbacks"]);
    expect(JSON.stringify(profile)).not.toContain("secret");
  });

  it("reports an invalid environment as ConfigError, like loadConfig", () => {
    expect(() => resolveProviderMode({ ANTHROPIC_API_KEY: "sk", AGENT_MAX_STEPS: "99" })).toThrow(ConfigError);
  });

  it("resolveProviderProfile accepts a parsed config", () => {
    expect(resolveProviderProfile(loadConfig({ AI_GATEWAY_API_KEY: "vck" })).mode).toBe("gateway-key");
  });
});

describe("toGatewayModelId", () => {
  it.each([
    ["claude-opus-5-5", "anthropic/claude-opus-5.5"],
    ["claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"],
    ["claude-haiku-5-5", "anthropic/claude-haiku-5.5"],
    ["claude-opus-5", "anthropic/claude-opus-5"],
    ["claude-sonnet-5", "anthropic/claude-sonnet-5"],
  ])("uses the explicit table: %s -> %s", (id, slug) => {
    expect(toGatewayModelId(id)).toBe(slug);
  });

  it("derives unknown ids: `-MAJOR-MINOR` becomes `.MINOR`, a bare major is kept", () => {
    expect(toGatewayModelId("claude-opus-4-8")).toBe("anthropic/claude-opus-4.8");
    expect(toGatewayModelId("claude-haiku-4-5")).toBe("anthropic/claude-haiku-4.5");
    expect(toGatewayModelId("claude-fable-5")).toBe("anthropic/claude-fable-5");
    // Only when the id ends in `-N-N`; a version in the middle is not touched.
    expect(toGatewayModelId("claude-3-7-sonnet")).toBe("anthropic/claude-3-7-sonnet");
    expect(toGatewayModelId("claude-opus-latest")).toBe("anthropic/claude-opus-latest");
  });

  it("passes a slug with a slash through unchanged", () => {
    expect(toGatewayModelId("anthropic/claude-opus-5.5")).toBe("anthropic/claude-opus-5.5");
    expect(toGatewayModelId("openai/gpt-5")).toBe("openai/gpt-5");
  });
});

describe("createClaudeClientForMode", () => {
  beforeEach(() => {
    getVercelOidcToken.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("anthropic: direct API with the key, never the gateway", async () => {
    const client = asSdk(await createClaudeClientForMode("anthropic", loadConfig({ ANTHROPIC_API_KEY: "sk-ant-x" })));
    expect(client.baseURL).toBe(ANTHROPIC_BASE);
    expect(client.apiKey).toBe("sk-ant-x");
    expect(client.authToken).toBeNull();
    expect(getVercelOidcToken).not.toHaveBeenCalled();
  });

  it("gateway-key: gateway base URL with the gateway key as the credential", async () => {
    const client = asSdk(await createClaudeClientForMode("gateway-key", loadConfig({ AI_GATEWAY_API_KEY: "vck_x" })));
    expect(client.baseURL).toBe(AI_GATEWAY_BASE_URL);
    expect(client.apiKey).toBe("vck_x");
    expect(client.authToken).toBeNull();
    expect(getVercelOidcToken).not.toHaveBeenCalled();
  });

  it("gateway-oidc: fetches the OIDC token and passes it as the bearer token with no API key", async () => {
    getVercelOidcToken.mockResolvedValue("oidc-token-1");
    const config = loadConfig({ VERCEL: "1", ANTHROPIC_API_KEY: "" });
    const client = asSdk(await createClaudeClientForMode("gateway-oidc", config));
    expect(client.baseURL).toBe(AI_GATEWAY_BASE_URL);
    expect(client.authToken).toBe("oidc-token-1");
    expect(client.apiKey).toBeNull();
    expect(getVercelOidcToken).toHaveBeenCalledTimes(1);
  });

  it("gateway-oidc: resolves the token on every call, so a rotated token yields a new client", async () => {
    getVercelOidcToken.mockResolvedValueOnce("token-a").mockResolvedValueOnce("token-b");
    const config = loadConfig({ VERCEL: "1" });
    const first = asSdk(await createClaudeClientForMode("gateway-oidc", config));
    const second = asSdk(await createClaudeClientForMode("gateway-oidc", config));
    expect(first).not.toBe(second);
    expect([first.authToken, second.authToken]).toEqual(["token-a", "token-b"]);
    expect(getVercelOidcToken).toHaveBeenCalledTimes(2);
  });

  it("gateway-oidc: a token failure surfaces as ConfigError without the SDK being involved", async () => {
    getVercelOidcToken.mockRejectedValue(new Error("OIDC federation is not enabled for this project"));
    await expect(createClaudeClientForMode("gateway-oidc", loadConfig({ VERCEL: "1" }))).rejects.toThrow(ConfigError);
    await expect(createClaudeClientForMode("gateway-oidc", loadConfig({ VERCEL: "1" }))).rejects.toThrow(/OIDC federation/);
  });

  it("openai: builds the adapter, not an Anthropic SDK client", async () => {
    const client = await createClaudeClientForMode("openai", loadConfig({ OPENAI_API_KEY: "sk-openai-x" }));
    expect(client).not.toBeInstanceOf(Anthropic);
    expect(typeof client.beta.messages.stream).toBe("function");
    expect(getVercelOidcToken).not.toHaveBeenCalled();
  });

  it("refuses a mode the configuration cannot serve", async () => {
    await expect(createClaudeClientForMode("anthropic", loadConfig({}))).rejects.toThrow(ConfigError);
    await expect(createClaudeClientForMode("openai", loadConfig({}))).rejects.toThrow(ConfigError);
    await expect(createClaudeClientForMode("gateway-key", loadConfig({}))).rejects.toThrow(ConfigError);
    await expect(createClaudeClientForMode("gateway-oidc", loadConfig({}))).rejects.toThrow(ConfigError);
    await expect(createClaudeClientForMode("unconfigured", loadConfig({}))).rejects.toThrow(ConfigError);
    expect(getVercelOidcToken).not.toHaveBeenCalled();
  });

  it("createClaudeClient(apiKey) still builds a direct-API client for scripts and tests", () => {
    const client = asSdk(createClaudeClient("sk-ant-legacy"));
    expect(client.baseURL).toBe(ANTHROPIC_BASE);
    expect(client.apiKey).toBe("sk-ant-legacy");
  });
});

describe("runTurn request profile", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function firstCall(useServerFallbacks: boolean | undefined) {
    const repos = createMemoryRepositories();
    const conversationId = (await repos.conversations.create("en")).id;
    const fake = createFakeClaude([textTurn("How long has this been going on?")]);
    const events = runTurn({
      conversationId,
      userText: "I have a rash",
      locale: "en",
      deps: { repos, client: fake.client, model: "anthropic/claude-opus-5.5", effort: "low", maxSteps: 3, useServerFallbacks },
    });
    for await (const event of events) void event; // drain
    expect(fake.calls).toHaveLength(1);
    return fake.calls[0];
  }

  it("keeps betas + fallbacks when useServerFallbacks is omitted (direct-API default)", async () => {
    const call = await firstCall(undefined);
    expect(call.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(call.fallbacks).toBe("default");
  });

  it("omits betas and fallbacks through the gateway but keeps effort, strict tools and cache_control", async () => {
    const call = await firstCall(false);
    expect(call).not.toHaveProperty("betas");
    expect(call).not.toHaveProperty("fallbacks");
    expect(call).not.toHaveProperty("cache_control"); // top-level form is direct-API only; the system marker stays
    expect(call.model).toBe("anthropic/claude-opus-5.5");
    expect(call.output_config).toEqual({ effort: "low" });
    const tools = call.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(tool).toMatchObject({ strict: true });
    if (!Array.isArray(call.system)) throw new Error("expected system blocks");
    expect(call.system[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
