/**
 * Multica-native value objects — the vocabulary this anti-corruption layer
 * translates AT the boundary (D8). These names never cross the package edge;
 * everything exported to Guild speaks @guild/shared types only.
 * Shapes verified live against v0.4.15 (M1a P13 + M1b write-path probes).
 */

/** task-run states observed via GET /api/issues/{id}/task-runs (M1a P13) */
export type MulticaTaskState =
  | "queued"
  | "dispatched"
  | "running"
  | "waiting_local_directory"
  | "deferred"
  | "completed"
  | "failed"
  | "cancelled";

/** issue statuses observed live; advisory only — status does not gate execution (P6) */
export type MulticaIssueStatus = "todo" | "in_progress" | "in_review" | "done";

export interface MulticaIssue {
  id: string;
  title: string;
  description: string;
  /** native string kept wide: unknown statuses must survive translation as data */
  status: string;
  assignee_id: string | null;
  /** creator attribution (P25): creator_id shares the /api/me actor id space */
  creator_type?: string;
  creator_id?: string;
  updated_at: string;
}

export interface MulticaTaskResult {
  output: string;
  pr_url: string;
  session_id: string;
  work_dir: string;
}

/** a registered daemon runtime — agents bind to one at creation (probe 2026-08-11: runtime_id is required) */
export interface MulticaRuntime {
  id: string;
  status: string;
  name?: string;
}

export interface MulticaComment {
  id: string;
  issue_id: string;
  content: string;
  parent_id: string | null;
  author_type: string;
  /** present on the wire (probe 2026-08-11: GET /comments returns it) — required for D15 actor attribution on the reconcile read path (#12) */
  author_id?: string;
  created_at: string;
}

export interface MulticaAgent {
  id: string;
  name: string;
  model: string;
  runtime_id: string;
}

export interface MulticaTaskRun {
  id: string;
  issue_id: string;
  agent_id: string;
  /** native string kept wide for the D8 unknown policy */
  status: string;
  failure_reason?: string | null;
  error?: string | null;
  result?: MulticaTaskResult | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}
