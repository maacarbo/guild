/**
 * PgGovernanceStore against the compose stack's Postgres, in the ISOLATED
 * `guild_test` database (#27): the suite truncates and leaves fixture rows,
 * and neither must ever be visible to a reconciling conductor — an override
 * URL contributes host/credentials only, never the database name.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StagePlan } from "@guild/shared";
import type { DecisionEntry } from "../domain/decisions.js";
import { governanceStoreContract } from "../testkit/governance-store-conformance.js";
import { LIVE_TEST_DATABASE, ensureIsolatedDatabase, isolatedDatabaseUrl } from "../testkit/live-db.js";
import { PgGovernanceStore } from "./pg-governance-store.js";

const live = process.env.GUILD_LIVE_STACK === "1";

function adminUrl(): string {
  if (process.env.GUILD_POSTGRES_URL) return process.env.GUILD_POSTGRES_URL;
  const password =
    process.env.GUILD_POSTGRES_PASSWORD ??
    /^GUILD_POSTGRES_PASSWORD=(.+)$/m.exec(
      readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "deploy", "compose", ".env"), "utf8"),
    )?.[1];
  if (!password) throw new Error("GUILD_POSTGRES_URL or GUILD_POSTGRES_PASSWORD required (deploy/compose/.env)");
  return `postgres://guild:${encodeURIComponent(password.trim())}@127.0.0.1:5442/guild`;
}

const connectionString = (): string => isolatedDatabaseUrl(adminUrl());

describe.runIf(live)("PgGovernanceStore (live)", () => {
  let store: PgGovernanceStore;

  beforeAll(async () => {
    await ensureIsolatedDatabase(adminUrl());
    store = await PgGovernanceStore.connect(connectionString());
    // the suite's OWN database (#27) — truncating here can never reach the conductor
    const pool = (store as unknown as { pool: { query(sql: string): Promise<unknown> } }).pool;
    await pool.query(
      "TRUNCATE engagements, decisions, dispatch_intents, gate_tickets, gate_decisions, plan_runs, stage_plans, dispatch_lock, role_memory",
    );
  });

  afterAll(async () => {
    await store?.close();
  });

  it(`runs against its own ${LIVE_TEST_DATABASE} database — never the conductor's (#27)`, async () => {
    const pool = (store as unknown as { pool: { query(sql: string): Promise<{ rows: { db: string }[] }> } }).pool;
    const { rows } = await pool.query("SELECT current_database() AS db");
    expect(rows[0]!.db).toBe(LIVE_TEST_DATABASE);
  });

  it("connects idempotently — ensureSchema twice is harmless", async () => {
    const again = await PgGovernanceStore.connect(connectionString());
    await again.close();
  });

  it("arms an idle-error listener so a backend restart cannot crash the process", () => {
    const pool = (store as unknown as { pool: { listenerCount(ev: string): number } }).pool;
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
  });

  it("round-trips an engagement record including item ref, validated sha, and judged attempt", async () => {
    await store.saveEngagement({
      engagementId: "eng-pg-1",
      stageId: "stage-1",
      planVersion: 1,
      state: "gated",
      bounceCount: 0,
    });
    await store.saveEngagement({
      engagementId: "eng-pg-1",
      stageId: "stage-1",
      planVersion: 1,
      state: "validated",
      bounceCount: 2,
      item: { substrate: "multica", externalId: "issue-77" },
      validatedSha: "abc123",
      lastBranch: "agent/worker/abc",
      lastJudgedSha: "abc123",
      lastJudgedAttempt: "run-42",
      terminalSpendCents: 57,
    });
    const rec = await store.getEngagement("eng-pg-1");
    expect(rec).toEqual({
      engagementId: "eng-pg-1",
      stageId: "stage-1",
      planVersion: 1,
      state: "validated",
      bounceCount: 2,
      item: { substrate: "multica", externalId: "issue-77" },
      validatedSha: "abc123",
      lastBranch: "agent/worker/abc",
      lastJudgedSha: "abc123",
      lastJudgedAttempt: "run-42",
      terminalSpendCents: 57,
    });
    expect(await store.getEngagement("eng-none")).toBeNull();
    expect((await store.listEngagements()).map((r) => r.engagementId)).toContain("eng-pg-1");
  });

  // CAS/uniqueness semantics are pinned by the shared contract suite below
  // (#12 item 5) — the same assertions the in-memory adapter runs in CI.
  governanceStoreContract("pg", () => store);

  it("gate tickets reverse-resolve from the board item", async () => {
    await store.saveGateTicket("stg:idea:analysis", 3, { substrate: "multica", externalId: "gate-77" });
    expect(await store.findGateTicketByItem({ substrate: "multica", externalId: "gate-77" })).toEqual({
      stageId: "stg:idea:analysis",
      planVersion: 3,
    });
    expect(await store.findGateTicketByItem({ substrate: "multica", externalId: "nope" })).toBeNull();
  });

  it("plan runs round-trip and update status", async () => {
    const run = {
      planId: "idea-1",
      ideaItem: { substrate: "multica", externalId: "idea-1" },
      rulesSha: "sha-rules-1",
      stageIds: ["stg:idea-1:analysis", "stg:idea-1:architecture"],
      status: "active" as const,
    };
    await store.savePlanRun(run);
    expect(await store.getPlanRun("idea-1")).toEqual(run);
    await store.savePlanRun({ ...run, status: "completed" });
    expect((await store.getPlanRun("idea-1"))?.status).toBe("completed");
    expect((await store.listPlanRuns()).map((r) => r.planId)).toContain("idea-1");
    expect(await store.getPlanRun("idea-none")).toBeNull();
  });

  it("stage plans round-trip by (stageId, version); the latest version wins the stage lookup", async () => {
    const plan = (v: number): StagePlan => ({
      projectId: "ws",
      stageId: "stg:idea-1:analysis",
      planVersion: v,
      kind: "analysis",
      objective: `v${v}`,
      budgetCents: 100,
      engagements: [],
    });
    await store.saveStagePlan(plan(1));
    await store.saveStagePlan(plan(2));
    expect((await store.getStagePlan("stg:idea-1:analysis", 1))?.objective).toBe("v1");
    expect((await store.getLatestStagePlan("stg:idea-1:analysis"))?.planVersion).toBe(2);
    expect(await store.getStagePlan("stg:idea-1:analysis", 9)).toBeNull();
    expect(await store.getLatestStagePlan("stg:none")).toBeNull();
  });

  it("the dispatch lock is a durable singleton: set, read, clear", async () => {
    expect(await store.getDispatchLock()).toBeNull();
    await store.setDispatchLock("budget_hard_cap: 1200/1000 cents", "t1");
    expect(await store.getDispatchLock()).toEqual({ reason: "budget_hard_cap: 1200/1000 cents", at: "t1" });
    await store.setDispatchLock("budget_hard_cap: updated", "t2");
    expect((await store.getDispatchLock())?.at).toBe("t2");
    await store.clearDispatchLock();
    expect(await store.getDispatchLock()).toBeNull();
  });

  it("appends decisions and reads them back in order", async () => {
    const a: DecisionEntry = { kind: "gate_posted", stageId: "s", planVersion: 1, at: "t1" };
    const b: DecisionEntry = {
      kind: "transition",
      engagementId: "eng-pg-1",
      from: "gated",
      to: "dispatched",
      cause: "test",
      at: "t2",
    };
    await store.appendDecision(a);
    await store.appendDecision(b);
    const all = await store.listDecisions();
    const idx = all.findIndex((d) => d.kind === "gate_posted");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(all[idx + 1]).toEqual(b);
  });

  it("dispatch intents are idempotent — the first at wins", async () => {
    await store.recordDispatchIntent("eng-pg-1", "t1");
    await store.recordDispatchIntent("eng-pg-1", "t9");
    expect(await store.listDispatchIntents()).toEqual(["eng-pg-1"]);
  });

  it("gate tickets round-trip by (stageId, planVersion)", async () => {
    await store.saveGateTicket("stage-1", 3, { substrate: "multica", externalId: "gate-9" });
    expect(await store.getGateTicket("stage-1", 3)).toEqual({ substrate: "multica", externalId: "gate-9" });
    expect(await store.getGateTicket("stage-1", 4)).toBeNull();
  });
});
