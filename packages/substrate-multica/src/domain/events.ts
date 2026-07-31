/**
 * WS frame → SubstrateEvent translation (pure). Frame shapes captured live
 * 2026-07-31; the event stream is a latency optimization — anything not
 * consumed by the conductor translates to null and reconciliation reads stay
 * the truth path (port contract).
 */

import type { SubstrateEvent } from "@guild/shared";
import { statusFromTaskState } from "./translation.js";

/** adapter stamps the eventId (per-stream uniqueness is an adapter obligation) */
export type RawSubstrateEvent =
  | Omit<Extract<SubstrateEvent, { kind: "status" }>, "eventId">
  | Omit<Extract<SubstrateEvent, { kind: "comment" }>, "eventId">;

interface TaskFramePayload {
  issue_id?: string;
  task_id?: string;
  status?: string;
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
): RawSubstrateEvent | null {
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
  if (frame.type === "comment:created") {
    const c = ((frame.payload ?? {}) as CommentFramePayload).comment;
    if (!c?.id || !c.issue_id) return null;
    return {
      kind: "comment",
      commentId: c.id,
      item: { substrate: substrateName, externalId: c.issue_id },
      author: c.author_id ?? c.author_type ?? "",
      body: c.content ?? "",
      at: c.created_at ?? receivedAt,
    };
  }
  return null;
}
