/**
 * PgGovernanceStore against the compose stack's Guild Postgres
 * (GUILD_LIVE_STACK-gated; the DB is published loopback-only for the
 * host-side conductor of the M1–M2a dev era). Truncates its tables at start —
 * this is the dev database, not a shared one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DecisionEntry } from "../domain/decisions.js";
import { PgGovernanceStore } from "./pg-governance-store.js";

const live = process.env.GUILD_LIVE_STACK === "1";

function connectionString(): string {
  if (process.env.GUILD_POSTGRES_URL) return process.env.GUILD_POSTGRES_URL;
  const password =
    process.env.GUILD_POSTGRES_PASSWORD ??
    /^GUILD_POSTGRES_PASSWORD=(.+)$/m.exec(
      readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "deploy", "compose", ".env"), "utf8"),
    )?.[1];
  if (!password) throw new Error("GUILD_POSTGRES_URL or GUILD_POSTGRES_PASSWORD required (deploy/compose/.env)");
  return `postgres://guild:${encodeURIComponent(password.trim())}@127.0.0.1:5442/guild`;
}

describe.runIf(live)("PgGovernanceStore (live)", () => {
  let store: PgGovernanceStore;

  beforeAll(async () => {
    store = await PgGovernanceStore.connect(connectionString());
    // dev DB, our tables only
    const pool = (store as unknown as { pool: { query(sql: string): Promise<unknown> } }).pool;
    await pool.query("TRUNCATE engagements, decisions, dispatch_intents, gate_tickets");
  });

  afterAll(async () => {
    await store?.close();
  });

  it("connects idempotently — ensureSchema twice is harmless", async () => {
    const again = await PgGovernanceStore.connect(connectionString());
    await again.close();
  });

  it("round-trips an engagement record including item ref and validated sha", async () => {
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
    });
    expect(await store.getEngagement("eng-none")).toBeNull();
    expect((await store.listEngagements()).map((r) => r.engagementId)).toContain("eng-pg-1");
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
