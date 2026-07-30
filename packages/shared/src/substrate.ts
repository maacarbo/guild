/**
 * Driven port over the execution substrate (D8). Multica is the first adapter
 * (packages/substrate-multica); this port is what keeps Guild substrate-agnostic —
 * the D8 fallback is "write a second adapter", not "rewrite Guild".
 * Substrate vocabulary (issues, comments, statuses) is translated at the adapter
 * boundary and never leaks into the domain.
 */

export interface WorkItemRef {
  substrate: string;
  externalId: string;
}

/**
 * Stable error categories on the substrate boundary — application code depends
 * on these, never on Multica-specific failure text (added 2026-07-30, external review).
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

export interface WorkItemSpec {
  engagementId: string;
  role: string;
  title: string;
  /**
   * serialized EngagementBrief: role context + instructions + contract +
   * prior decisions + artifact refs + constraints, composed by the conductor —
   * dropping any of these reproduces the fresh-context loss the brief exists to prevent
   */
  body: string;
}

export type SubstrateEvent =
  | { kind: "status"; item: WorkItemRef; status: string; at: string }
  | { kind: "comment"; item: WorkItemRef; author: string; body: string; at: string }
  | { kind: "usage"; item: WorkItemRef; tokens: number; usd?: number; at: string };

export interface ExecutionSubstrate {
  readonly name: string;
  createWorkItem(spec: WorkItemSpec): Promise<WorkItemRef>;
  assign(item: WorkItemRef, agent: string): Promise<void>;
  comment(item: WorkItemRef, body: string): Promise<void>;
  cancel(item: WorkItemRef, reason: string): Promise<void>;
  watch(projectScope: string): AsyncIterable<SubstrateEvent>;
}
