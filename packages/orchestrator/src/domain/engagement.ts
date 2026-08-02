/**
 * Engagement aggregate (pure): the lifecycle state machine of ARCHITECTURE.md,
 * with the D6 bounce rules built in. The conductor applies events; illegal
 * moves are rejected, never coerced — a rejected transition is the caller's
 * signal to log-and-ignore (terminal absorption: the first persisted decision
 * wins) or to raise desync.
 */

import { MAX_BOUNCES, type CancellationReason, type EngagementState } from "@guild/shared";

export interface Engagement {
  engagementId: string;
  stageId: string;
  planVersion: number;
  state: EngagementState;
  /** lifetime count; verdict_failed beyond MAX_BOUNCES escalates instead of bouncing */
  bounceCount: number;
}

export type EngagementEvent =
  | { kind: "posted_for_approval" }
  | { kind: "dispatch_succeeded" }
  | { kind: "gate_rejected" }
  | { kind: "work_started" }
  | { kind: "question_raised" }
  | { kind: "question_answered" }
  | { kind: "reported" }
  | { kind: "verdict_passed" }
  | { kind: "verdict_failed" }
  /** infrastructure fault — validation retries; the work is never bounced for it */
  | { kind: "validator_errored" }
  | { kind: "accepted" }
  | { kind: "cancelled"; reason: CancellationReason };

export type TransitionResult =
  | { ok: true; engagement: Engagement }
  | { ok: false; reason: "terminal_state" | "illegal_transition"; detail: string };

const TERMINAL: ReadonlySet<EngagementState> = new Set(["accepted", "cancelled"]);

export function transition(engagement: Engagement, event: EngagementEvent): TransitionResult {
  const { state } = engagement;

  if (TERMINAL.has(state)) {
    return { ok: false, reason: "terminal_state", detail: `${event.kind} after terminal ${state}` };
  }

  // escalated is terminal-pending-operator: only cancellation (or rescope via a
  // new engagement) leaves it
  if (state === "escalated" && event.kind !== "cancelled") {
    return { ok: false, reason: "illegal_transition", detail: `${event.kind} in escalated` };
  }

  const to = (next: EngagementState, over: Partial<Engagement> = {}): TransitionResult => ({
    ok: true,
    engagement: { ...engagement, ...over, state: next },
  });
  const illegal = (): TransitionResult => ({
    ok: false,
    reason: "illegal_transition",
    detail: `${event.kind} in ${state}`,
  });

  switch (event.kind) {
    case "posted_for_approval":
      return state === "planned" ? to("gated") : illegal();
    case "dispatch_succeeded":
      return state === "gated" ? to("dispatched") : illegal();
    case "gate_rejected":
      return state === "gated" ? to("cancelled") : illegal();
    case "work_started":
      return state === "dispatched" || state === "bounced" ? to("working") : illegal();
    case "question_raised":
      return state === "working" ? to("blocked") : illegal();
    case "question_answered":
      return state === "blocked" ? to("working") : illegal();
    case "reported":
      return state === "working" ? to("reported") : illegal();
    case "verdict_passed":
      return state === "reported" ? to("validated") : illegal();
    case "verdict_failed":
      if (state !== "reported") return illegal();
      return engagement.bounceCount >= MAX_BOUNCES
        ? to("escalated")
        : to("bounced", { bounceCount: engagement.bounceCount + 1 });
    case "validator_errored":
      return state === "reported" ? to("reported") : illegal();
    case "accepted":
      return state === "validated" ? to("accepted") : illegal();
    case "cancelled":
      return to("cancelled");
  }
}
