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

import type { EngagementBrief, Lane } from "./stages.js";
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
  /**
   * substrate-native id of the attempt (task run) that produced this report —
   * the per-attempt rework signal: a bounced engagement whose branch head has
   * not moved but whose attemptId HAS is a hollow rework, judged as such
   * instead of stranded (M2a verify follow-up, issue #11; evidence P13)
   */
  attemptId?: string;
}

export interface WorkItemSnapshot {
  item: WorkItemRef;
  status: WorkItemStatus;
  /** native status string, advisory — diagnostics and the decisions log only (P9b repair evidence) */
  nativeStatus?: string;
  /** item title as the substrate shows it (P25: first-class on every read surface) */
  title: string;
  /** item body — the planner reads idea and amendment text from here (P25) */
  body: string;
  /**
   * who created the item (D12 idea detection): attributed from native creator
   * identity exactly like lane_moved actors (P25: issue creator_id shares the
   * actor id space); unmapped creator types surface as "unknown" (D8)
   */
  createdBy: BoardActor;
  /**
   * the embedded guild marker (engagement id or reserved-prefix ticket marker)
   * if this item carries one — extraction is the adapter's job so marker
   * ENCODING never crosses the port; absence marks an idea candidate (D12)
   */
  markerId?: string;
  /**
   * board lane (D11) — independent of the execution status above: nothing
   * substrate-side auto-moves the lane, including task completion (P19), so
   * the lane is exactly what the conductor (or a human) last set. Unmapped
   * native board statuses surface as "unknown" (D8 closed-union policy).
   */
  lane: Lane | "unknown";
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
 * A governance ticket (D11): a board ticket that is NOT an engagement — no
 * agent, no brief, no contract. The plan-approval ticket is the first use;
 * idea tickets (M2b planner) are the second. markerId shares the engagementId
 * marker namespace, so findWorkItem gives the same idempotency guarantee —
 * callers use reserved prefixes (e.g. "gate:<stageId>:v<planVersion>") that
 * can never collide with engagement ids.
 */
export interface TicketSpec {
  markerId: string;
  title: string;
  /** rendered body (e.g. the plan for approval); adapter appends the marker */
  body: string;
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
/**
 * Who changed the board (D11 zero-discretion rule needs to know). Adapters
 * attribute from native actor identity (evidence: matrix P22 — every Multica
 * activity entry carries actor_id + actor_type): "conductor" when the actor is
 * the adapter's own identity, "operator" only for a member on the explicit
 * operator allowlist (D15), "agent" for agent-driven changes — which the
 * conductor IGNORES as forward signals (validation verdicts are the only
 * forward path) — and "unknown" for every other member and unmapped actor type
 * (closed-union policy, D8). Note (D15, audit #17 A5d): "operator" is an
 * allowlist, NOT "any other human" — mapping every non-conductor member to the
 * most-privileged actor is the defect this union's closed policy forbids.
 */
export type BoardActor = "operator" | "conductor" | "agent" | "unknown";

export type SubstrateEvent =
  | { kind: "status"; eventId: string; item: WorkItemRef; status: WorkItemStatus; at: string }
  /**
   * an item appeared on the board (D12 idea detection; evidence P24:
   * issue:created pushes the full issue with creator attribution). Carries the
   * creation-time content so live detection needs no follow-up read; the
   * reconciliation listWorkItems read stays the truth path.
   */
  | {
      kind: "item_created";
      eventId: string;
      item: WorkItemRef;
      title: string;
      body: string;
      createdBy: BoardActor;
      lane: Lane | "unknown";
      at: string;
    }
  /**
   * a board lane change (D11 trigger surface; evidence P21: pushed on every
   * mutation, no polling needed). lane is the mapped value of the NEW native
   * board status; nativeStatus preserves it for diagnostics.
   */
  | { kind: "lane_moved"; eventId: string; item: WorkItemRef; lane: Lane | "unknown"; nativeStatus: string; actor: BoardActor; at: string }
  | { kind: "comment"; eventId: string; commentId: string; item: WorkItemRef; author: string; actor: BoardActor; body: string; at: string }
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
  /** governance ticket (D11) — same marker mechanics as createWorkItem, no agent/brief */
  createTicket(spec: TicketSpec): Promise<WorkItemRef>;
  /** dispatch-saga idempotency lookup: called before createWorkItem/createTicket; keyed on the embedded marker */
  findWorkItem(engagementId: string): Promise<WorkItemRef | null>;
  getWorkItem(item: WorkItemRef): Promise<WorkItemSnapshot>;
  /**
   * Reconciliation read — the normative truth path after any WS gap or
   * conductor restart. Returns the WHOLE board (M2b): marker-less items are
   * exactly the idea candidates (D12) — callers do marker discipline via
   * snapshot.markerId, never by expecting the adapter to pre-filter.
   */
  listWorkItems(projectScope: string): Promise<WorkItemSnapshot[]>;
  assign(item: WorkItemRef, agent: string): Promise<void>;
  /**
   * Route the role's subsequent work through the given gateway credential —
   * the per-engagement virtual key (D2). Delivery is runtime-env injection,
   * proven end-to-end at M1 (per-engagement spend attribution). Wholesale
   * replacement is safe because one agent holds at most one open engagement
   * (CLAUDE.md invariant); call BEFORE createWorkItem — assignment dispatches
   * immediately (P6), so a late bind leaks spend onto the previous credential.
   */
  bindEngagementKey(role: string, key: string): Promise<void>;
  /**
   * board projection write (D11): the conductor is the sole lane authority —
   * idempotent (setting the current lane is a no-op) and total over Lane
   * (evidence P20: the native status enum covers all seven values 1:1).
   * Nothing substrate-side ever moves a lane back (P19), so a successful set
   * is durable until the next explicit set or a human move.
   */
  setLane(item: WorkItemRef, lane: Lane): Promise<void>;
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
   * close/lock the item in its terminal lane. Verified (M1a P6): substrate-side
   * status does NOT gate execution — replies on a closed item still enqueue
   * work — so close is advisory bookkeeping; the enforcement layer is key
   * revocation plus the conductor's ignore-after-terminal rule (first persisted
   * decision wins). terminalLane distinguishes accepted work (done) from
   * cancelled/killed/capped work (cancelled) so the board's Done lane never
   * shows work that was not accepted (D11 lane table; #17 B9).
   */
  close(item: WorkItemRef, terminalLane?: Lane): Promise<void>;
  /**
   * Event stream (latency optimization; reads are truth). Cancellation: abort
   * the signal — that closes the underlying transport and ends the iterable
   * even while it is parked awaiting the next event; a consumer-side `break`
   * alone cannot wake a parked stream. Scope faults surface lazily on first
   * pull (async-generator semantics), not at call time.
   */
  watch(projectScope: string, opts?: { signal?: AbortSignal }): AsyncIterable<SubstrateEvent>;
}
