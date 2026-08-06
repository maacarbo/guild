/**
 * WS frame → SubstrateEvent translation (pure). Frame shapes captured live
 * 2026-07-31; the event stream is a latency optimization — anything not
 * consumed by the conductor translates to null and reconciliation reads stay
 * the truth path (port contract).
 */

import type { SubstrateEvent } from "@guild/shared";
import { actorFrom, laneFromNativeStatus, statusFromTaskState } from "./translation.js";

/** adapter stamps the eventId (per-stream uniqueness is an adapter obligation) */
export type RawSubstrateEvent =
  | Omit<Extract<SubstrateEvent, { kind: "status" }>, "eventId">
  | Omit<Extract<SubstrateEvent, { kind: "lane_moved" }>, "eventId">
  | Omit<Extract<SubstrateEvent, { kind: "comment" }>, "eventId">
  | Omit<Extract<SubstrateEvent, { kind: "item_created" }>, "eventId">;

interface TaskFramePayload {
  issue_id?: string;
  task_id?: string;
  status?: string;
}

/** live shape 2026-08-02 (P21/P22): semantic audit entry with actor + from/to */
interface ActivityFramePayload {
  issue_id?: string;
  entry?: {
    id?: string;
    action?: string;
    actor_id?: string;
    actor_type?: string;
    created_at?: string;
    details?: { to?: string; from?: string };
  };
}

/** live shape 2026-08-03 (P24): the full issue rides in payload.issue */
interface IssueCreatedFramePayload {
  issue?: {
    id?: string;
    title?: string;
    description?: string;
    status?: string;
    creator_type?: string;
    creator_id?: string;
    created_at?: string;
  };
}

interface CommentFramePayload {
  comment?: {
    id?: string;
    issue_id?: string;
    author_id?: string;
    author_type?: string;
    content?: string;
    created_at?: string;
  };
}

export function substrateEventFromFrame(
  substrateName: string,
  frame: { type: string; payload: unknown },
  receivedAt: string,
  /** the adapter's own member id — conductor-vs-operator attribution (P22); the composition root requires it */
  selfMemberId = "",
  /** explicit operator allowlist (D15) — a member reads as "operator" only on membership; empty = fail-closed */
  operatorMemberIds: readonly string[] = [],
): RawSubstrateEvent | null {
  if (frame.type === "activity:created") {
    // lane_moved sources from the activity entry, not issue:updated — the
    // activity carries the actor (P22); the issue frame does not
    const p = (frame.payload ?? {}) as ActivityFramePayload;
    const to = p.entry?.details?.to;
    if (p.entry?.action !== "status_changed" || !p.issue_id || !to) return null;
    return {
      kind: "lane_moved",
      item: { substrate: substrateName, externalId: p.issue_id },
      lane: laneFromNativeStatus(to),
      nativeStatus: to,
      actor: actorFrom(p.entry.actor_type, p.entry.actor_id, selfMemberId, operatorMemberIds),
      at: p.entry.created_at ?? receivedAt,
    };
  }
  if (frame.type.startsWith("task:")) {
    const p = (frame.payload ?? {}) as TaskFramePayload;
    if (!p.issue_id) return null;
    // task:dispatch carries no status field — dispatch is pre-execution (queued);
    // progress/message frames carry no state either and are not status changes
    if (frame.type === "task:progress" || frame.type === "task:message") return null;
    const native = p.status ?? (frame.type === "task:dispatch" ? "dispatched" : "");
    return {
      kind: "status",
      item: { substrate: substrateName, externalId: p.issue_id },
      status: statusFromTaskState(native),
      at: receivedAt,
    };
  }
  if (frame.type === "issue:created") {
    // idea-detection trigger (D12): the full issue rides in the frame (P24) —
    // no follow-up read needed; reconciliation reads stay the truth path
    const issue = ((frame.payload ?? {}) as IssueCreatedFramePayload).issue;
    if (!issue?.id) return null;
    return {
      kind: "item_created",
      item: { substrate: substrateName, externalId: issue.id },
      title: issue.title ?? "",
      body: issue.description ?? "",
      createdBy: actorFrom(issue.creator_type, issue.creator_id, selfMemberId, operatorMemberIds),
      lane: laneFromNativeStatus(issue.status ?? ""),
      at: issue.created_at ?? receivedAt,
    };
  }
  if (frame.type === "comment:created") {
    const c = ((frame.payload ?? {}) as CommentFramePayload).comment;
    if (!c?.id || !c.issue_id) return null;
    return {
      kind: "comment",
      commentId: c.id,
      item: { substrate: substrateName, externalId: c.issue_id },
      author: c.author_id ?? c.author_type ?? "",
      actor: actorFrom(c.author_type, c.author_id, selfMemberId, operatorMemberIds),
      body: c.content ?? "",
      at: c.created_at ?? receivedAt,
    };
  }
  return null;
}
