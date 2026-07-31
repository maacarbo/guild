/**
 * Driven port over the execution substrate (D8). Multica is the first adapter
 * (packages/substrate-multica); this port is what keeps Guild substrate-agnostic —
 * the D8 fallback is "write a second adapter", not "rewrite Guild".
 * Substrate vocabulary (issues, comments, statuses) is translated at the adapter
 * boundary and never leaks into the domain.
 *
 * Truth model (normative, added 2026-07-30): the event stream is a latency
 * optimization; the read operations are the truth path. The conductor reconciles
 * on every (re)connect and applies per-state liveness timeouts — a missed event
 * must never strand an engagement.
 */

import type { EngagementBrief } from "./stages.js";
import type { ContractVerdict } from "./contract.js";
import type { CancellationReason } from "./governance.js";

export interface WorkItemRef {
  substrate: string;
  externalId: string;
}

/**
 * Port-level status vocabulary — a CLOSED union (D8). Adapters map native
 * statuses onto these; a native status with no mapping MUST surface as
 * "unknown" — the conductor parks the engagement and raises desync — and is
 * never silently mapped to the nearest neighbor.
 */
export type WorkItemStatus =
  | "queued"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled"
  | "unknown";

/**
 * Failure classification on the work-item level — a CLOSED union with the same
 * D8 policy as WorkItemStatus: unmapped native failure reasons surface as
 * "unknown", never as the nearest neighbor. Evidence (M1a P10): a budget-capped
 * virtual key fails the task with a native reason the adapter maps to
 * "provider_capacity_or_budget"; the conductor's operator-action map renders it
 * as "engagement budget cap reached" when the engagement's key is capped.
 */
export type WorkItemFailureCategory =
  | "provider_capacity_or_budget"
  | "agent_error"
  | "unknown";

export interface WorkItemFailure {
  category: WorkItemFailureCategory;
  /** native failure text, advisory — for the decisions log, never for branching */
  detail: string;
}

/**
 * What the substrate reports when an agent finishes work. Evidence (M1a P3/P7):
 * the native result is free text only — no commit SHA, no structured branch —
 * and branch names are stable only within a daemon lifetime. The adapter derives
 * branchHint deterministically per task; the conductor must resolve it to a
 * commit SHA ONCE at report time via the git boundary (D6 SHA-pinning) and
 * never dereference the branch name again.
 */
export interface WorkReport {
  /** agent's free-text completion summary — advisory, never validated as truth (D6) */
  summary: string;
  /** advisory branch name the work landed on; resolve to SHA immediately, then discard */
  branchHint?: string;
}

export interface WorkItemSnapshot {
  item: WorkItemRef;
  status: WorkItemStatus;
  /** native status string, advisory — diagnostics and the decisions log only (P9b repair evidence) */
  nativeStatus?: string;
  /** present when status is "failed" */
  failure?: WorkItemFailure;
  /** present once the agent has reported work (latest report wins) */
  report?: WorkReport;
  assignedAgent?: string;
  updatedAt: string;
}

export interface WorkItemSpec {
  /**
   * transport copy of EngagementPlan.engagementId (the single owner) — embedded
   * in the work item as the idempotency/reconciliation marker for findWorkItem
   */
  engagementId: string;
  role: string;
  title: string;
  /** structured brief; the adapter serializes it into the substrate's native body format */
  brief: EngagementBrief;
}

/**
 * eventId is unique per watch stream (dedup/ordering in logs); substrates that
 * don't carry native event ids get adapter-synthesized ones — that is an
 * adapter obligation, not a substrate capability assumption.
 *
 * The "usage" event is advisory display data only (M1a P11): the substrate
 * reports zero usage for failed items and cannot cost gateway-alias models —
 * the ModelGateway is the spend source of truth, always.
 */
export type SubstrateEvent =
  | { kind: "status"; eventId: string; item: WorkItemRef; status: WorkItemStatus; at: string }
  | { kind: "comment"; eventId: string; commentId: string; item: WorkItemRef; author: string; body: string; at: string }
  | { kind: "usage"; eventId: string; item: WorkItemRef; tokens: number; costCents?: number; at: string };

/**
 * Stable error categories on the substrate boundary — application code depends
 * on these, never on Multica-specific failure text. The set must totalize:
 * an unexpected substrate-side fault (e.g. HTTP 5xx) maps to
 * "substrate_internal" (retryable per response), never to a guessed neighbor —
 * the same closed-union discipline as WorkItemStatus (D8).
 */
export type SubstrateErrorCategory =
  | "auth"
  | "not_found"
  | "unsupported_capability"
  | "conflict"
  | "transport"
  | "substrate_internal"
  | "desync";

export interface SubstrateError {
  category: SubstrateErrorCategory;
  message: string;
  retryable: boolean;
}

const SUBSTRATE_ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  "auth",
  "not_found",
  "unsupported_capability",
  "conflict",
  "transport",
  "substrate_internal",
  "desync",
] satisfies SubstrateErrorCategory[]);

/** structural guard — adapters throw Error subclasses carrying the SubstrateError shape */
export function isSubstrateError(e: unknown): e is SubstrateError {
  return (
    typeof e === "object" &&
    e !== null &&
    "category" in e &&
    typeof (e as SubstrateError).category === "string" &&
    SUBSTRATE_ERROR_CATEGORIES.has((e as SubstrateError).category) &&
    typeof (e as SubstrateError).retryable === "boolean"
  );
}

export interface ExecutionSubstrate {
  readonly name: string;
  createWorkItem(spec: WorkItemSpec): Promise<WorkItemRef>;
  /** dispatch-saga idempotency lookup: called before createWorkItem; keyed on the embedded engagementId marker */
  findWorkItem(engagementId: string): Promise<WorkItemRef | null>;
  getWorkItem(item: WorkItemRef): Promise<WorkItemSnapshot>;
  /** reconciliation read — the normative truth path after any WS gap or conductor restart */
  listWorkItems(projectScope: string): Promise<WorkItemSnapshot[]>;
  assign(item: WorkItemRef, agent: string): Promise<void>;
  comment(item: WorkItemRef, body: string, opts?: { inReplyTo?: string }): Promise<void>;
  /**
   * bounce delivery: posts the verdict's failing criteria such that the
   * implementing agent resumes. Verified (M1a P5): a top-level conductor
   * comment triggers the implementing agent — threading is not required.
   * Bounce comments must be self-contained (M1a P7): agent session state does
   * not survive a substrate restart, only the comment text carries context.
   */
  requestRework(item: WorkItemRef, verdict: ContractVerdict): Promise<void>;
  /**
   * Idempotent (M1a P4): cancelling an already-terminal item is a no-op, never
   * an error — conductor retries are safe. On a live item, cancel kills the
   * agent process and stops model traffic within seconds; the conductor calls
   * this eagerly on key revocation instead of waiting for natural failure
   * (M1a P10: capped items otherwise linger "running" in retry backoff).
   */
  cancel(item: WorkItemRef, reason: CancellationReason): Promise<void>;
  /**
   * termination protocol: terminal engagement state ⇒ revoke virtual key +
   * close/lock the item. Verified (M1a P6): substrate-side status does NOT
   * gate execution — replies on a closed item still enqueue work — so close is
   * advisory bookkeeping; the enforcement layer is key revocation plus the
   * conductor's ignore-after-terminal rule (first persisted decision wins).
   */
  close(item: WorkItemRef): Promise<void>;
  /**
   * Event stream (latency optimization; reads are truth). Cancellation: abort
   * the signal — that closes the underlying transport and ends the iterable
   * even while it is parked awaiting the next event; a consumer-side `break`
   * alone cannot wake a parked stream. Scope faults surface lazily on first
   * pull (async-generator semantics), not at call time.
   */
  watch(projectScope: string, opts?: { signal?: AbortSignal }): AsyncIterable<SubstrateEvent>;
}
