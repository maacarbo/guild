/**
 * Live-suite database isolation (#27): every live test suite and smoke runs
 * against its OWN database (`guild_test`) on the stack's Postgres — TRUNCATE
 * and fixture rows must be structurally unable to reach the database a
 * reconciling conductor reads (the 2026-08-11 incident: a truncated
 * `plan_runs` made the next conductor restart re-adopt 11 old ideas).
 *
 * The rewrite is unconditional: an explicit override URL contributes host and
 * credentials, never the database name.
 */

import pg from "pg";

export const LIVE_TEST_DATABASE = "guild_test";

export function isolatedDatabaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = `/${LIVE_TEST_DATABASE}`;
  return url.toString();
}

/** create the isolated database on demand (the stack's `guild` role is the instance superuser) */
export async function ensureIsolatedDatabase(adminUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await pool.query(`CREATE DATABASE ${LIVE_TEST_DATABASE}`);
  } catch (e) {
    if ((e as { code?: string }).code !== "42P04") throw e; // 42P04 = duplicate_database
  } finally {
    await pool.end();
  }
}
