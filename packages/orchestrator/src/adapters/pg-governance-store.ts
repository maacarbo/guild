/**
 * GovernanceStore over plain Postgres (D4: governance state is a plain
 * schema, not an event bus). The schema is created idempotently on connect —
 * the conductor owns its own tables; there is no separate migration step
 * before M2b needs one. decisions is INSERT-only by construction: nothing in
 * this adapter updates or deletes a decision row, ever.
 */

import pg from "pg";
import type { WorkItemRef } from "@guild/shared";
import type { DecisionEntry } from "../domain/decisions.js";
import type { EngagementRecord, GovernanceStore } from "../ports/governance-store.js";

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

  private async ensureSchema(): Promise<void> {
    await this.pool.query(`
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
    `);
  }

  async saveEngagement(record: EngagementRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO engagements (engagement_id, stage_id, plan_version, state, bounce_count, item, validated_sha, last_branch, last_judged_sha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (engagement_id) DO UPDATE SET
         state = EXCLUDED.state,
         bounce_count = EXCLUDED.bounce_count,
         item = EXCLUDED.item,
         validated_sha = EXCLUDED.validated_sha,
         last_branch = EXCLUDED.last_branch,
         last_judged_sha = EXCLUDED.last_judged_sha`,
      [
        record.engagementId,
        record.stageId,
        record.planVersion,
        record.state,
        record.bounceCount,
        record.item ? JSON.stringify(record.item) : null,
        record.validatedSha ?? null,
        record.lastBranch ?? null,
        record.lastJudgedSha ?? null,
      ],
    );
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
}
