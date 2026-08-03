import { describe, expect, it } from "vitest";
import type { MulticaIssue, MulticaTaskRun } from "./multica-types.js";
import { deriveSnapshot } from "./snapshot.js";

const issue = (over: Partial<MulticaIssue> = {}): MulticaIssue => ({
  id: "issue-1",
  title: "t",
  description: "d",
  status: "in_progress",
  assignee_id: "agent-1",
  updated_at: "2026-07-31T10:00:00Z",
  ...over,
});

const run = (over: Partial<MulticaTaskRun> = {}): MulticaTaskRun => ({
  id: "aaaabbbb-0000-0000-0000-000000000000",
  issue_id: "issue-1",
  agent_id: "agent-1",
  status: "completed",
  created_at: "2026-07-31T10:01:00Z",
  completed_at: "2026-07-31T10:02:00Z",
  result: { output: "Done.", pr_url: "", session_id: "s", work_dir: "w" },
  ...over,
});

const ref = { substrate: "multica", externalId: "issue-1" };

describe("deriveSnapshot", () => {
  it("reports queued when no task run exists yet (trigger pending)", () => {
    const s = deriveSnapshot(ref, issue(), [], "worker");
    expect(s.status).toBe("queued");
    expect(s.report).toBeUndefined();
    expect(s.failure).toBeUndefined();
  });

  it("maps the LATEST run's state, not an earlier one", () => {
    const s = deriveSnapshot(
      ref,
      issue(),
      [
        run({ id: "11111111-a", status: "completed", created_at: "2026-07-31T10:01:00Z" }),
        run({ id: "22222222-b", status: "running", created_at: "2026-07-31T10:05:00Z", completed_at: null, result: null }),
      ],
      "worker",
    );
    expect(s.status).toBe("running");
  });

  it("retains the report from the latest completed run while a bounce is in flight", () => {
    const s = deriveSnapshot(
      ref,
      issue(),
      [
        run({ id: "11111111-a", status: "completed", created_at: "2026-07-31T10:01:00Z" }),
        run({ id: "22222222-b", status: "running", created_at: "2026-07-31T10:05:00Z", completed_at: null, result: null }),
      ],
      "worker",
    );
    expect(s.report).toEqual({ summary: "Done.", branchHint: "agent/worker/11111111", attemptId: "11111111-a" });
  });

  it("derives branchHint from the run that produced the report (P7: per-task branches)", () => {
    const s = deriveSnapshot(ref, issue(), [run({ id: "555f8277-x" })], "probe-opencode");
    expect(s.report?.branchHint).toBe("agent/probe-opencode/555f8277");
  });

  it("suppresses a stale report when a LATER run failed — failure is the actionable signal", () => {
    const s = deriveSnapshot(
      ref,
      issue(),
      [
        run({ id: "11111111-a", status: "completed", created_at: "2026-07-31T10:01:00Z" }),
        run({
          id: "22222222-b",
          status: "failed",
          failure_reason: "agent_error.provider_capacity_or_rate_limit",
          created_at: "2026-07-31T10:05:00Z",
          completed_at: null,
          result: null,
        }),
      ],
      "worker",
    );
    expect(s.status).toBe("failed");
    expect(s.failure?.category).toBe("provider_capacity_or_budget");
    expect(s.report).toBeUndefined();
  });

  it("suppresses a stale report when a LATER run was cancelled", () => {
    const s = deriveSnapshot(
      ref,
      issue(),
      [
        run({ id: "11111111-a", status: "completed", created_at: "2026-07-31T10:01:00Z" }),
        run({ id: "22222222-b", status: "cancelled", created_at: "2026-07-31T10:05:00Z", completed_at: null, result: null }),
      ],
      "worker",
    );
    expect(s.report).toBeUndefined();
  });

  it("classifies failure on a failed latest run", () => {
    const s = deriveSnapshot(
      ref,
      issue(),
      [run({ status: "failed", failure_reason: "agent_error.provider_capacity_or_rate_limit", result: null })],
      "worker",
    );
    expect(s.status).toBe("failed");
    expect(s.failure?.category).toBe("provider_capacity_or_budget");
  });

  it("surfaces an unknown native state as unknown and preserves it in nativeStatus", () => {
    const s = deriveSnapshot(ref, issue(), [run({ status: "hibernating", result: null })], "worker");
    expect(s.status).toBe("unknown");
    expect(s.nativeStatus).toContain("hibernating");
  });

  it("passes the assignee and the item ref through", () => {
    const s = deriveSnapshot(ref, issue(), [], "worker");
    expect(s.item).toEqual(ref);
    expect(s.assignedAgent).toBe("agent-1");
  });

  it("updatedAt is the latest of issue and run timestamps", () => {
    const s = deriveSnapshot(
      ref,
      issue({ updated_at: "2026-07-31T10:00:00Z" }),
      [run({ completed_at: "2026-07-31T10:02:00Z" })],
      "worker",
    );
    expect(s.updatedAt).toBe("2026-07-31T10:02:00Z");
  });
});

describe("content and creator surfaces (M2b idea detection + rework attempts, P24/P25)", () => {
  const SELF = "8b2e9ba1-0514-4613-9678-c5e33c561cad";

  it("carries the issue title and body — the planner reads ideas from snapshots", () => {
    const s = deriveSnapshot(ref, issue({ title: "Idea: tiny utility", description: "budget: 2.00" }), [], "worker", SELF);
    expect(s.title).toBe("Idea: tiny utility");
    expect(s.body).toBe("budget: 2.00");
  });

  it("attributes a member-created issue to the operator", () => {
    const s = deriveSnapshot(ref, issue({ creator_type: "member", creator_id: "someone-else" }), [], "worker", SELF);
    expect(s.createdBy).toBe("operator");
  });

  it("attributes the conductor's own issues as conductor", () => {
    const s = deriveSnapshot(ref, issue({ creator_type: "member", creator_id: SELF }), [], "worker", SELF);
    expect(s.createdBy).toBe("conductor");
  });

  it("attributes agent-created issues as agent and unmapped creator types as unknown (D8)", () => {
    expect(deriveSnapshot(ref, issue({ creator_type: "agent", creator_id: "a1" }), [], "worker", SELF).createdBy).toBe(
      "agent",
    );
    expect(deriveSnapshot(ref, issue({ creator_type: "webhook", creator_id: "w1" }), [], "worker", SELF).createdBy).toBe(
      "unknown",
    );
  });

  it("exposes an embedded guild marker; absent marker means idea candidate (D12)", () => {
    const marked = deriveSnapshot(
      ref,
      issue({ description: "brief\n\n<!-- guild:engagement=eng-7 -->" }),
      [],
      "worker",
      SELF,
    );
    expect(marked.markerId).toBe("eng-7");
    expect(deriveSnapshot(ref, issue({ description: "just an idea" }), [], "worker", SELF).markerId).toBeUndefined();
  });

  it("stamps the report with the completed run's id — the per-attempt rework signal (#11)", () => {
    const s = deriveSnapshot(ref, issue(), [run({ id: "555f8277-x" })], "worker", SELF);
    expect(s.report?.attemptId).toBe("555f8277-x");
  });

  it("the attempt id follows the run that produced the report, not a later in-flight run", () => {
    const s = deriveSnapshot(
      ref,
      issue(),
      [
        run({ id: "11111111-a", status: "completed", created_at: "2026-07-31T10:01:00Z" }),
        run({ id: "22222222-b", status: "running", created_at: "2026-07-31T10:05:00Z", completed_at: null, result: null }),
      ],
      "worker",
      SELF,
    );
    expect(s.report?.attemptId).toBe("11111111-a");
  });
});

describe("board lane derivation (D11: the lane is exactly what was last set — P19)", () => {
  it("derives the lane from the issue's native board status, independent of task state", () => {
    const s = deriveSnapshot(ref, issue({ status: "in_review" }), [run({ status: "running", result: null })], "worker");
    expect(s.lane).toBe("ready_for_testing");
    expect(s.status).toBe("running");
  });

  it("surfaces an unmapped native board status as lane unknown (D8)", () => {
    const s = deriveSnapshot(ref, issue({ status: "triaging" }), [], "worker");
    expect(s.lane).toBe("unknown");
  });
});
