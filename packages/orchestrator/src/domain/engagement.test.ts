import { describe, expect, it } from "vitest";
import { MAX_BOUNCES } from "@guild/shared";
import { transition, type Engagement, type EngagementEvent } from "./engagement.js";

const fresh = (over: Partial<Engagement> = {}): Engagement => ({
  engagementId: "eng-1",
  stageId: "stage-1",
  planVersion: 1,
  state: "planned",
  bounceCount: 0,
  ...over,
});

const apply = (e: Engagement, ...events: EngagementEvent[]): Engagement =>
  events.reduce((cur, ev) => {
    const r = transition(cur, ev);
    if (!r.ok) throw new Error(`unexpected rejection: ${r.reason} (${r.detail})`);
    return r.engagement;
  }, e);

describe("engagement state machine", () => {
  it("walks the happy path to acceptance", () => {
    const done = apply(
      fresh(),
      { kind: "posted_for_approval" },
      { kind: "dispatch_succeeded" },
      { kind: "work_started" },
      { kind: "reported" },
      { kind: "verdict_passed" },
      { kind: "accepted" },
    );
    expect(done.state).toBe("accepted");
    expect(done.bounceCount).toBe(0);
  });

  it("round-trips a blocker: a question halts work and the answer resumes it", () => {
    const blocked = apply(fresh({ state: "working" }), { kind: "question_raised" });
    expect(blocked.state).toBe("blocked");
    expect(apply(blocked, { kind: "question_answered" }).state).toBe("working");
  });

  it("bounces a failed verdict back to the go lane with an incremented count", () => {
    const bounced = apply(fresh({ state: "reported" }), { kind: "verdict_failed" });
    expect(bounced.state).toBe("bounced");
    expect(bounced.bounceCount).toBe(1);
    expect(apply(bounced, { kind: "work_started" }).state).toBe("working");
  });

  it(`escalates instead of re-bouncing once ${MAX_BOUNCES} bounces are spent`, () => {
    const atLimit = fresh({ state: "reported", bounceCount: MAX_BOUNCES });
    const escalated = apply(atLimit, { kind: "verdict_failed" });
    expect(escalated.state).toBe("escalated");
    expect(escalated.bounceCount).toBe(MAX_BOUNCES);
  });

  it("keeps the engagement in reported on a validator error — infrastructure faults never bounce the work", () => {
    const still = apply(fresh({ state: "reported" }), { kind: "validator_errored" });
    expect(still.state).toBe("reported");
    expect(still.bounceCount).toBe(0);
  });

  it("cancels a rejected stage rather than dispatching it", () => {
    const rejected = apply(fresh({ state: "gated" }), { kind: "gate_rejected" });
    expect(rejected.state).toBe("cancelled");
  });

  it("allows operator cancellation from any live state", () => {
    for (const state of ["planned", "gated", "dispatched", "working", "blocked", "reported", "validated", "bounced"] as const) {
      const cancelled = apply(fresh({ state }), { kind: "cancelled", reason: "operator" });
      expect(cancelled.state).toBe("cancelled");
    }
  });

  it("lets the operator cancel an escalated engagement but nothing else touch it", () => {
    const escalated = fresh({ state: "escalated", bounceCount: MAX_BOUNCES });
    expect(apply(escalated, { kind: "cancelled", reason: "bounce_limit" }).state).toBe("cancelled");
    const r = transition(escalated, { kind: "work_started" });
    expect(r.ok).toBe(false);
  });

  it("absorbs events arriving after a terminal decision — the first persisted decision wins", () => {
    for (const state of ["accepted", "cancelled"] as const) {
      const r = transition(fresh({ state }), { kind: "reported" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("terminal_state");
    }
  });

  it("rejects transitions the lifecycle does not define", () => {
    const r = transition(fresh({ state: "planned" }), { kind: "reported" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("illegal_transition");
  });
});
