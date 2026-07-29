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

export interface WorkItemSpec {
  engagementId: string;
  role: string;
  title: string;
  /** engagement brief: instructions + contract, composed by the conductor */
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
