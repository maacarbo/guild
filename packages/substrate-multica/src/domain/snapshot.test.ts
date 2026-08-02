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
    expect(s.report).toEqual({ summary: "Done.", branchHint: "agent/worker/11111111" });
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
