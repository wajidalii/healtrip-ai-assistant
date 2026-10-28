/**
 * Lazy Postgres connection. Nothing connects at import time, so the app and
 * the tests can run without a database when DATABASE_URL is unset.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfig } from "@/server/config";
import { schema, type Schema } from "@/server/db/schema";

export type Db = PostgresJsDatabase<Schema>;

type Connection = { sql: postgres.Sql; db: Db };

let connection: Connection | undefined;

export function isDatabaseConfigured(): boolean {
  return getConfig().databaseUrl !== undefined;
}

/** Returns the singleton Drizzle instance; throws if DATABASE_URL is not set. */
export function getDb(): Db {
  if (connection) return connection.db;
  const url = getConfig().databaseUrl;
  if (!url) {
    throw new Error("DATABASE_URL is not set; the Postgres client is unavailable");
  }
  // A small pool is plenty for a prototype and keeps serverless cold starts cheap.
  const sql = postgres(url, { max: 5, prepare: false });
  connection = { sql, db: drizzle(sql, { schema }) };
  return connection.db;
}

/** Closes the pool (used by scripts such as the seeder so the process can exit). */
export async function closeDb(): Promise<void> {
  if (!connection) return;
  const { sql } = connection;
  connection = undefined;
  await sql.end({ timeout: 5 });
}
