/**
 * Chooses the repository implementation from configuration: Postgres when
 * DATABASE_URL is set, otherwise the in-memory implementation seeded with the
 * same data. Resolved once per process.
 */
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { createMemoryRepositories } from "@/server/repositories/memory";
import { createPostgresRepositories } from "@/server/repositories/postgres";
import type { Repositories } from "@/server/repositories/types";

let instance: Repositories | undefined;

export function getRepositories(): Repositories {
  if (instance) return instance;
  instance = getConfig().databaseUrl ? createPostgresRepositories(getDb()) : createMemoryRepositories();
  console.info(`[repositories] using ${instance.kind} implementation`);
  return instance;
}
