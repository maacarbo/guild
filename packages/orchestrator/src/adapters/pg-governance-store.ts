/**
 * GovernanceStore over plain Postgres (D4: governance state is a plain
 * schema, not an event bus). The schema is created idempotently on connect —
 * the conductor owns its own tables; there is no separate migration step
 * before M2b needs one. decisions is INSERT-only by construction: nothing in
 * this adapter updates or deletes a decision row, ever.
 */

import pg from "pg";
import type { EngagementState, GateDecision, StagePlan, WorkItemRef } from "@guild/shared";
import type { DecisionEntry } from "../domain/decisions.js";
import type {
  EngagementRecord,
  GateTicketKey,
  GovernanceStore,
  PlanRunRecord,
} from "../ports/governance-store.js";

interface EngagementRow {
  engagement_id: string;
  stage_id: string;
  plan_version: number;
  state: EngagementRecord["state"];
  bounce_count: number;
  item: WorkItemRef | null;
  validated_sha: string | null;
  last_branch: string | null;
  last_judged_sha: string | null;
  last_judged_attempt: string | null;
}

function toRecord(row: EngagementRow): EngagementRecord {
  return {
    engagementId: row.engagement_id,
    stageId: row.stage_id,
    planVersion: row.plan_version,
    state: row.state,
    bounceCount: row.bounce_count,
    ...(row.item ? { item: row.item } : {}),
    ...(row.validated_sha ? { validatedSha: row.validated_sha } : {}),
    ...(row.last_branch ? { lastBranch: row.last_branch } : {}),
    ...(row.last_judged_sha ? { lastJudgedSha: row.last_judged_sha } : {}),
    ...(row.last_judged_attempt ? { lastJudgedAttempt: row.last_judged_attempt } : {}),
  };
}

export class PgGovernanceStore implements GovernanceStore {
  private constructor(private readonly pool: pg.Pool) {}

  static async connect(connectionString: string): Promise<PgGovernanceStore> {
    const pool = new pg.Pool({ connectionString, max: 5 });
    // an idle client errors when the backend restarts or the network blips;
    // without a listener node treats that as an uncaught exception and kills
    // the process (node-postgres documented behavior; M2a verify finding).
    // The pool discards the dead client itself — logging is the handling.
    pool.on("error", (err) => {
      console.error(`guild-pg: idle client error (recoverable): ${err.message}`);
    });
    const store = new PgGovernanceStore(pool);
    await store.ensureSchema();
    return store;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** two conductors booting on a fresh database race their DDL without this (#11) */
  private static readonly SCHEMA_LOCK_KEY = 0x6775696c; // 'guil'

  private async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [PgGovernanceStore.SCHEMA_LOCK_KEY]);
      await this.createTables(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [PgGovernanceStore.SCHEMA_LOCK_KEY]).catch(() => undefined);
      client.release();
    }
  }

  private async createTables(client: pg.PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS engagements (
        engagement_id text PRIMARY KEY,
        stage_id      text NOT NULL,
        plan_version  integer NOT NULL,
        state         text NOT NULL,
        bounce_count  integer NOT NULL,
        item          jsonb,
        validated_sha text
      );
      ALTER TABLE engagements ADD COLUMN IF NOT EXISTS last_branch text;
      ALTER TABLE engagements ADD COLUMN IF NOT EXISTS last_judged_sha text;
      ALTER TABLE engagements ADD COLUMN IF NOT EXISTS last_judged_attempt text;
      CREATE TABLE IF NOT EXISTS decisions (
        seq   bigserial PRIMARY KEY,
        entry jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatch_intents (
        engagement_id text PRIMARY KEY,
        at            text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gate_tickets (
        gate_key text PRIMARY KEY,
        item     jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gate_decisions (
        gate_key text PRIMARY KEY,
        decision jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_runs (
        plan_id   text PRIMARY KEY,
        idea_item jsonb,
        stage_ids jsonb NOT NULL,
        status    text NOT NULL
      );
      ALTER TABLE plan_runs ALTER COLUMN idea_item DROP NOT NULL;
      CREATE TABLE IF NOT EXISTS stage_plans (
        stage_id     text NOT NULL,
        plan_version integer NOT NULL,
        plan         jsonb NOT NULL,
        PRIMARY KEY (stage_id, plan_version)
      );
      CREATE TABLE IF NOT EXISTS dispatch_lock (
        id     integer PRIMARY KEY CHECK (id = 1),
        reason text NOT NULL,
        at     text NOT NULL
      );
    `);
  }

  private engagementParams(record: EngagementRecord): unknown[] {
    return [
      record.engagementId,
      record.stageId,
      record.planVersion,
      record.state,
      record.bounceCount,
      record.item ? JSON.stringify(record.item) : null,
      record.validatedSha ?? null,
      record.lastBranch ?? null,
      record.lastJudgedSha ?? null,
      record.lastJudgedAttempt ?? null,
    ];
  }

  async saveEngagement(record: EngagementRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO engagements (engagement_id, stage_id, plan_version, state, bounce_count, item, validated_sha, last_branch, last_judged_sha, last_judged_attempt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (engagement_id) DO UPDATE SET
         state = EXCLUDED.state,
         bounce_count = EXCLUDED.bounce_count,
         item = EXCLUDED.item,
         validated_sha = EXCLUDED.validated_sha,
         last_branch = EXCLUDED.last_branch,
         last_judged_sha = EXCLUDED.last_judged_sha,
         last_judged_attempt = EXCLUDED.last_judged_attempt`,
      this.engagementParams(record),
    );
  }

  async saveEngagementIf(record: EngagementRecord, expectedState: EngagementState): Promise<boolean> {
    // the state predicate rides in the UPDATE itself — a single-statement CAS (#11)
    const res = await this.pool.query(
      `UPDATE engagements SET
         state = $2, bounce_count = $3, item = $4, validated_sha = $5,
         last_branch = $6, last_judged_sha = $7, last_judged_attempt = $8
       WHERE engagement_id = $1 AND state = $9`,
      [
        record.engagementId,
        record.state,
        record.bounceCount,
        record.item ? JSON.stringify(record.item) : null,
        record.validatedSha ?? null,
        record.lastBranch ?? null,
        record.lastJudgedSha ?? null,
        record.lastJudgedAttempt ?? null,
        expectedState,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getEngagement(engagementId: string): Promise<EngagementRecord | null> {
    const res = await this.pool.query<EngagementRow>(
      "SELECT * FROM engagements WHERE engagement_id = $1",
      [engagementId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async listEngagements(): Promise<EngagementRecord[]> {
    const res = await this.pool.query<EngagementRow>("SELECT * FROM engagements ORDER BY engagement_id");
    return res.rows.map(toRecord);
  }

  async appendDecision(entry: DecisionEntry): Promise<void> {
    await this.pool.query("INSERT INTO decisions (entry) VALUES ($1)", [JSON.stringify(entry)]);
  }

  async listDecisions(): Promise<DecisionEntry[]> {
    const res = await this.pool.query<{ entry: DecisionEntry }>("SELECT entry FROM decisions ORDER BY seq");
    return res.rows.map((r) => r.entry);
  }

  async recordDispatchIntent(engagementId: string, at: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO dispatch_intents (engagement_id, at) VALUES ($1, $2) ON CONFLICT (engagement_id) DO NOTHING",
      [engagementId, at],
    );
  }

  async listDispatchIntents(): Promise<string[]> {
    const res = await this.pool.query<{ engagement_id: string }>(
      "SELECT engagement_id FROM dispatch_intents ORDER BY engagement_id",
    );
    return res.rows.map((r) => r.engagement_id);
  }

  async saveGateTicket(stageId: string, planVersion: number, item: WorkItemRef): Promise<void> {
    await this.pool.query(
      `INSERT INTO gate_tickets (gate_key, item) VALUES ($1, $2)
       ON CONFLICT (gate_key) DO UPDATE SET item = EXCLUDED.item`,
      [`${stageId}:v${planVersion}`, JSON.stringify(item)],
    );
  }

  async getGateTicket(stageId: string, planVersion: number): Promise<WorkItemRef | null> {
    const res = await this.pool.query<{ item: WorkItemRef }>(
      "SELECT item FROM gate_tickets WHERE gate_key = $1",
      [`${stageId}:v${planVersion}`],
    );
    return res.rows[0]?.item ?? null;
  }

  async findGateTicketByItem(item: WorkItemRef): Promise<GateTicketKey | null> {
    const res = await this.pool.query<{ gate_key: string }>(
      "SELECT gate_key FROM gate_tickets WHERE item->>'externalId' = $1",
      [item.externalId],
    );
    const key = res.rows[0]?.gate_key;
    if (!key) return null;
    const at = key.lastIndexOf(":v");
    return { stageId: key.slice(0, at), planVersion: Number.parseInt(key.slice(at + 2), 10) };
  }

  async recordGateDecision(decision: GateDecision): Promise<boolean> {
    const res = await this.pool.query(
      "INSERT INTO gate_decisions (gate_key, decision) VALUES ($1, $2) ON CONFLICT (gate_key) DO NOTHING",
      [`${decision.stageId}:v${decision.planVersion}`, JSON.stringify(decision)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getGateDecision(stageId: string, planVersion: number): Promise<GateDecision | null> {
    const res = await this.pool.query<{ decision: GateDecision }>(
      "SELECT decision FROM gate_decisions WHERE gate_key = $1",
      [`${stageId}:v${planVersion}`],
    );
    return res.rows[0]?.decision ?? null;
  }

  async savePlanRun(run: PlanRunRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO plan_runs (plan_id, idea_item, stage_ids, status) VALUES ($1, $2, $3, $4)
       ON CONFLICT (plan_id) DO UPDATE SET stage_ids = EXCLUDED.stage_ids, status = EXCLUDED.status`,
      [run.planId, run.ideaItem ? JSON.stringify(run.ideaItem) : null, JSON.stringify(run.stageIds), run.status],
    );
  }

  private static toPlanRun(row: {
    plan_id: string;
    idea_item: WorkItemRef | null;
    stage_ids: string[];
    status: PlanRunRecord["status"];
  }): PlanRunRecord {
    return {
      planId: row.plan_id,
      ...(row.idea_item ? { ideaItem: row.idea_item } : {}),
      stageIds: row.stage_ids,
      status: row.status,
    };
  }

  async getPlanRun(planId: string): Promise<PlanRunRecord | null> {
    const res = await this.pool.query<{
      plan_id: string;
      idea_item: WorkItemRef | null;
      stage_ids: string[];
      status: PlanRunRecord["status"];
    }>("SELECT * FROM plan_runs WHERE plan_id = $1", [planId]);
    return res.rows[0] ? PgGovernanceStore.toPlanRun(res.rows[0]) : null;
  }

  async listPlanRuns(): Promise<PlanRunRecord[]> {
    const res = await this.pool.query<{
      plan_id: string;
      idea_item: WorkItemRef | null;
      stage_ids: string[];
      status: PlanRunRecord["status"];
    }>("SELECT * FROM plan_runs ORDER BY plan_id");
    return res.rows.map((row) => PgGovernanceStore.toPlanRun(row));
  }

  async saveStagePlan(plan: StagePlan): Promise<void> {
    await this.pool.query(
      `INSERT INTO stage_plans (stage_id, plan_version, plan) VALUES ($1, $2, $3)
       ON CONFLICT (stage_id, plan_version) DO UPDATE SET plan = EXCLUDED.plan`,
      [plan.stageId, plan.planVersion, JSON.stringify(plan)],
    );
  }

  async getStagePlan(stageId: string, planVersion: number): Promise<StagePlan | null> {
    const res = await this.pool.query<{ plan: StagePlan }>(
      "SELECT plan FROM stage_plans WHERE stage_id = $1 AND plan_version = $2",
      [stageId, planVersion],
    );
    return res.rows[0]?.plan ?? null;
  }

  async getLatestStagePlan(stageId: string): Promise<StagePlan | null> {
    const res = await this.pool.query<{ plan: StagePlan }>(
      "SELECT plan FROM stage_plans WHERE stage_id = $1 ORDER BY plan_version DESC LIMIT 1",
      [stageId],
    );
    return res.rows[0]?.plan ?? null;
  }

  async setDispatchLock(reason: string, at: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO dispatch_lock (id, reason, at) VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET reason = EXCLUDED.reason, at = EXCLUDED.at`,
      [reason, at],
    );
  }

  async getDispatchLock(): Promise<{ reason: string; at: string } | null> {
    const res = await this.pool.query<{ reason: string; at: string }>("SELECT reason, at FROM dispatch_lock WHERE id = 1");
    return res.rows[0] ?? null;
  }

  async clearDispatchLock(): Promise<void> {
    await this.pool.query("DELETE FROM dispatch_lock WHERE id = 1");
  }
}
