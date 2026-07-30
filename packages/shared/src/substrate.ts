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

export interface WorkItemSnapshot {
  item: WorkItemRef;
  status: WorkItemStatus;
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

export type SubstrateEvent =
  | { kind: "status"; eventId: string; item: WorkItemRef; status: WorkItemStatus; at: string }
  | { kind: "comment"; eventId: string; commentId: string; item: WorkItemRef; author: string; body: string; at: string }
  | { kind: "usage"; eventId: string; item: WorkItemRef; tokens: number; costCents?: number; at: string };

/**
 * Stable error categories on the substrate boundary — application code depends
 * on these, never on Multica-specific failure text.
 */
export type SubstrateErrorCategory =
  | "auth"
  | "not_found"
  | "unsupported_capability"
  | "conflict"
  | "transport"
  | "desync";

export interface SubstrateError {
  category: SubstrateErrorCategory;
  message: string;
  retryable: boolean;
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
   * implementing agent resumes (M1a probes whether top-level conductor comments
   * trigger agents, or whether threading via inReplyTo is required)
   */
  requestRework(item: WorkItemRef, verdict: ContractVerdict): Promise<void>;
  cancel(item: WorkItemRef, reason: CancellationReason): Promise<void>;
  /** termination protocol: terminal engagement state ⇒ revoke virtual key + close/lock the item */
  close(item: WorkItemRef): Promise<void>;
  watch(projectScope: string): AsyncIterable<SubstrateEvent>;
}
