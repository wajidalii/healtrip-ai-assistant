/**
 * Shared behavioural suite for both repository implementations.
 *
 * The memory suite always runs. The Postgres suite runs only when
 * DATABASE_URL is set and expects the schema to exist; apply it first with
 * `npx drizzle-kit push` (or `npm run db:push`) and seed with `npm run db:seed`.
 * The Postgres suite seeds the providers it needs itself, so a seeded table is
 * not required, but an applied schema is.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { SEED_PROVIDERS } from "@/server/db/seed-data";
import { createMemoryRepositories } from "@/server/repositories/memory";
import type { Repositories } from "@/server/repositories/types";

const CARDIOLOGIST_ISTANBUL = "41d456cd-2271-48aa-a326-fbf9818757b3"; // Dr. Elif Kaya
const INACTIVE_DERMATOLOGIST = "485acef4-d0c4-4293-b244-d6e162a0a60b"; // Dr. Sarah Collins
const AL_NOOR_DUBAI = "0dbe298b-087d-4fa1-895b-8ddc59b84a89";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function repositorySuite(getRepos: () => Repositories) {
  describe("providers.search", () => {
    it("filters by specialty, excludes inactive rows and orders by rating desc, name asc", async () => {
      const { results, total } = await getRepos().providers.search({ specialty: "dermatology", limit: 20 });
      expect(results.length).toBeGreaterThan(0);
      expect(total).toBe(results.length);
      expect(results.every((p) => p.specialties.includes("dermatology"))).toBe(true);
      expect(results.map((p) => p.id)).not.toContain(INACTIVE_DERMATOLOGIST);
      for (let i = 1; i < results.length; i += 1) {
        const prev = results[i - 1];
        const next = results[i];
        expect(prev.rating >= next.rating).toBe(true);
        if (prev.rating === next.rating) expect(prev.nameEn <= next.nameEn).toBe(true);
      }
    });

    it("matches city case-insensitively", async () => {
      const lower = await getRepos().providers.search({ specialty: "cardiology", city: "istanbul", limit: 20 });
      const upper = await getRepos().providers.search({ specialty: "cardiology", city: "ISTANBUL", limit: 20 });
      expect(lower.total).toBeGreaterThan(0);
      expect(lower.results.map((p) => p.id)).toEqual(upper.results.map((p) => p.id));
      expect(lower.results.every((p) => p.city === "Istanbul")).toBe(true);
    });

    it("filters by language and country", async () => {
      const { results } = await getRepos().providers.search({
        specialty: "cardiology",
        language: "ar",
        country: "AE",
        limit: 20,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((p) => p.languages.includes("ar") && p.country === "AE")).toBe(true);
    });

    it("filters by emergencyCapable", async () => {
      const { results } = await getRepos().providers.search({
        specialty: "emergency_medicine",
        emergencyCapable: true,
        limit: 20,
      });
      expect(results.length).toBeGreaterThanOrEqual(4);
      expect(results.every((p) => p.emergencyCapable)).toBe(true);
      expect(new Set(results.map((p) => p.city)).size).toBeGreaterThanOrEqual(4);
    });

    it("filters by telemedicine", async () => {
      const { results } = await getRepos().providers.search({ specialty: "cardiology", telemedicine: true, limit: 20 });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((p) => p.telemedicine)).toBe(true);
    });

    it("applies limit while total counts all matches", async () => {
      const { results, total } = await getRepos().providers.search({ specialty: "cardiology", limit: 2 });
      expect(results).toHaveLength(2);
      expect(total).toBeGreaterThan(2);
      expect(results[0].id).toBe(AL_NOOR_DUBAI); // highest-rated cardiology provider in the seed
    });

    it("returns an empty page with total 0 when nothing matches", async () => {
      const { results, total } = await getRepos().providers.search({ specialty: "dentistry", city: "Riyadh", limit: 5 });
      expect(results).toEqual([]);
      expect(total).toBe(0);
    });
  });

  describe("providers.getById / getManyByIds", () => {
    it("returns the full provider including inactive flag and parent", async () => {
      const doctor = await getRepos().providers.getById(CARDIOLOGIST_ISTANBUL);
      expect(doctor?.kind).toBe("doctor");
      expect(doctor?.parentProviderId).not.toBeNull();
      expect(doctor?.isActive).toBe(true);
      const inactive = await getRepos().providers.getById(INACTIVE_DERMATOLOGIST);
      expect(inactive?.isActive).toBe(false);
    });

    it("returns null for an unknown id", async () => {
      expect(await getRepos().providers.getById("00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("preserves input order and skips unknown ids", async () => {
      const ids = [AL_NOOR_DUBAI, "00000000-0000-4000-8000-000000000000", CARDIOLOGIST_ISTANBUL];
      const result = await getRepos().providers.getManyByIds(ids);
      expect(result.map((p) => p.id)).toEqual([AL_NOOR_DUBAI, CARDIOLOGIST_ISTANBUL]);
      expect(await getRepos().providers.getManyByIds([])).toEqual([]);
    });

    it("returns copies that cannot mutate stored data", async () => {
      const first = await getRepos().providers.getById(AL_NOOR_DUBAI);
      first?.specialties.push("dentistry");
      const second = await getRepos().providers.getById(AL_NOOR_DUBAI);
      expect(second?.specialties).not.toContain("dentistry");
    });
  });

  describe("conversations", () => {
    it("creates and fetches a conversation", async () => {
      const created = await getRepos().conversations.create("ar");
      expect(created.locale).toBe("ar");
      expect(created.status).toBe("open");
      expect(created.createdAt).toBeInstanceOf(Date);
      const fetched = await getRepos().conversations.get(created.id);
      expect(fetched?.id).toBe(created.id);
      expect(await getRepos().conversations.get("00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("appends messages with monotonic seq and replays content verbatim", async () => {
      const { conversations } = getRepos();
      const convo = await conversations.create("en");
      const userBlocks = [{ type: "text", text: "I have chest pain" }];
      const assistantBlocks = [
        { type: "thinking", thinking: "...", signature: "sig" },
        { type: "tool_use", id: "toolu_1", name: "assess_urgency", input: { redFlags: [] } },
      ];
      const m1 = await conversations.appendMessage(convo.id, "user", userBlocks);
      const m2 = await conversations.appendMessage(convo.id, "assistant", assistantBlocks);
      const m3 = await conversations.appendMessage(convo.id, "user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]);
      expect([m1.seq, m2.seq, m3.seq]).toEqual([m1.seq, m1.seq + 1, m1.seq + 2]);

      const listed = await conversations.listMessages(convo.id);
      expect(listed.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
      expect(listed.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(listed[1].content).toEqual(assistantBlocks);
      expect(await conversations.listMessages("00000000-0000-4000-8000-000000000000")).toEqual([]);
    });

    it("records and lists tool calls", async () => {
      const { conversations } = getRepos();
      const convo = await conversations.create("en");
      const call = await conversations.recordToolCall({
        conversationId: convo.id,
        toolUseId: "toolu_1",
        toolName: "search_providers",
        input: { specialty: "cardiology" },
        output: { ids: [AL_NOOR_DUBAI] },
        isError: false,
        latencyMs: 12,
      });
      expect(call.id).toBeTruthy();
      expect(call.createdAt).toBeInstanceOf(Date);
      await conversations.recordToolCall({
        conversationId: convo.id,
        toolUseId: "toolu_2",
        toolName: "get_provider",
        input: { id: "bad" },
        output: { error: "not found" },
        isError: true,
        latencyMs: 3,
      });
      const listed = await conversations.listToolCalls(convo.id);
      expect(listed.map((c) => c.toolUseId)).toEqual(["toolu_1", "toolu_2"]);
      expect(listed[0].output).toEqual({ ids: [AL_NOOR_DUBAI] });
      expect(listed[1].isError).toBe(true);
    });

    it("saves a recommendation hydrated with providers in the given order", async () => {
      const { conversations } = getRepos();
      const convo = await conversations.create("en");
      const saved = await conversations.saveRecommendation({
        conversationId: convo.id,
        nextStep: "specialist_consultation",
        urgency: "urgent",
        specialty: "cardiology",
        providerIds: [CARDIOLOGIST_ISTANBUL, AL_NOOR_DUBAI],
        rationale: "Chest pain without red flags; see a cardiologist within 24h.",
        questionsRemaining: ["How long has the pain lasted?"],
      });
      expect(saved.providers.map((p) => p.id)).toEqual([CARDIOLOGIST_ISTANBUL, AL_NOOR_DUBAI]);
      expect(saved.providers[0].nameEn).toBe("Dr. Elif Kaya");
      expect(saved.questionsRemaining).toEqual(["How long has the pain lasted?"]);
      expect(() => new Date(saved.createdAt).toISOString()).not.toThrow();

      const listed = await conversations.listRecommendations(convo.id);
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(saved.id);
      expect(listed[0].providers.map((p) => p.id)).toEqual([CARDIOLOGIST_ISTANBUL, AL_NOOR_DUBAI]);
    });

    it("turn lock: acquire, reject while held, release, expire", async () => {
      const { conversations } = getRepos();
      const convo = await conversations.create("en");
      expect(await conversations.tryAcquireTurnLock(convo.id, 60_000)).toBe(true);
      expect(await conversations.tryAcquireTurnLock(convo.id, 60_000)).toBe(false);
      await conversations.releaseTurnLock(convo.id);
      expect(await conversations.tryAcquireTurnLock(convo.id, 50)).toBe(true);
      expect(await conversations.tryAcquireTurnLock(convo.id, 50)).toBe(false);
      await sleep(120);
      expect(await conversations.tryAcquireTurnLock(convo.id, 60_000)).toBe(true);
      await conversations.releaseTurnLock(convo.id);
      expect(await conversations.tryAcquireTurnLock("00000000-0000-4000-8000-000000000000", 1000)).toBe(false);
    });
  });
}

describe("seed data", () => {
  it("has unique ids, parents in the same city, and covers every requirement", () => {
    const ids = new Set(SEED_PROVIDERS.map((p) => p.id));
    expect(ids.size).toBe(SEED_PROVIDERS.length);
    const byId = new Map(SEED_PROVIDERS.map((p) => [p.id, p]));
    for (const p of SEED_PROVIDERS) {
      if (p.kind === "doctor") {
        const parent = byId.get(p.parentProviderId ?? "");
        expect(parent, `${p.nameEn} parent`).toBeDefined();
        expect(parent?.kind).not.toBe("doctor");
        expect(parent?.city).toBe(p.city);
      } else {
        expect(p.parentProviderId).toBeNull();
      }
      expect(p.rating).toBeGreaterThanOrEqual(3.8);
      expect(p.rating).toBeLessThanOrEqual(4.9);
    }
    expect(SEED_PROVIDERS.filter((p) => !p.isActive)).toHaveLength(1);
  });
});

describe("memory repositories", () => {
  let repos: Repositories;
  beforeAll(() => {
    repos = createMemoryRepositories();
  });
  repositorySuite(() => repos);
});

describe.skipIf(!process.env.DATABASE_URL)("postgres repositories", () => {
  let repos: Repositories;
  let cleanup: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    const { getDb, closeDb } = await import("@/server/db/client");
    const { providers } = await import("@/server/db/schema");
    const { createPostgresRepositories } = await import("@/server/repositories/postgres");
    const db = getDb();
    // Upsert the seed so the suite is self-contained against an empty schema.
    await db
      .insert(providers)
      .values(SEED_PROVIDERS)
      .onConflictDoUpdate({
        target: providers.id,
        set: { isActive: sql`excluded.is_active`, rating: sql`excluded.rating`, nameEn: sql`excluded.name_en` },
      });
    repos = createPostgresRepositories(db);
    cleanup = closeDb;
  });

  afterAll(async () => {
    await cleanup();
  });

  repositorySuite(() => repos);
});
