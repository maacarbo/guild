import { describe, expect, it } from "vitest";
import {
  actorFrom,
  branchHintFor,
  classifyFailure,
  classifyHttpError,
  embedEngagementMarker,
  extractEngagementId,
  laneFromNativeStatus,
  nativeStatusFromLane,
  statusFromTaskState,
} from "./translation.js";

describe("task-state → port status mapping (D8 closed union)", () => {
  it.each([
    ["queued", "queued"],
    ["dispatched", "queued"],
    ["deferred", "queued"],
    ["running", "running"],
    ["waiting_local_directory", "blocked"],
    ["completed", "done"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ])("maps native %s to %s", (native, port) => {
    expect(statusFromTaskState(native)).toBe(port);
  });

  it("surfaces an unmapped native state as unknown, never a neighbor", () => {
    expect(statusFromTaskState("paused_for_review")).toBe("unknown");
    expect(statusFromTaskState("")).toBe("unknown");
  });
});

describe("failure classification (M1a P10 evidence)", () => {
  it("classifies the budget-capped 429 reason as provider_capacity_or_budget", () => {
    expect(classifyFailure("agent_error.provider_capacity_or_rate_limit").category).toBe(
      "provider_capacity_or_budget",
    );
  });

  it("classifies other agent errors as agent_error", () => {
    expect(classifyFailure("agent_error.session_crashed").category).toBe("agent_error");
  });

  it("surfaces unmapped reasons as unknown with the native text preserved", () => {
    const f = classifyFailure("something_new_from_a_pin_bump");
    expect(f.category).toBe("unknown");
    expect(f.detail).toBe("something_new_from_a_pin_bump");
  });

  it("treats a missing reason as unknown", () => {
    expect(classifyFailure(null).category).toBe("unknown");
    expect(classifyFailure(undefined).category).toBe("unknown");
  });
});

describe("branch hint derivation (M1a P3/P16 naming, P7 instability)", () => {
  it("derives agent/<name>/<task-id-first-8>", () => {
    expect(branchHintFor("probe-opencode", "555f8277-aaaa-bbbb-cccc-000000000000")).toBe(
      "agent/probe-opencode/555f8277",
    );
  });
});

describe("engagement idempotency marker (metadata is not persisted — live probe)", () => {
  it("round-trips through an issue description", () => {
    const desc = embedEngagementMarker("Do the work.\nCarefully.", "eng-01HXYZ");
    expect(extractEngagementId(desc)).toBe("eng-01HXYZ");
    expect(desc).toContain("Do the work.");
  });

  it("returns null when no marker is present", () => {
    expect(extractEngagementId("plain description")).toBeNull();
  });
});

describe("HTTP fault → SubstrateErrorCategory (closed set, totalizing)", () => {
  it.each([
    [401, "auth", false],
    [403, "auth", false],
    [404, "not_found", false],
    [409, "conflict", false],
    [400, "desync", false],
    [405, "desync", false],
    [422, "desync", false],
    [429, "transport", true],
    [500, "substrate_internal", true],
    [503, "substrate_internal", true],
  ])("maps %d to %s (retryable: %s)", (code, category, retryable) => {
    const e = classifyHttpError(code);
    expect(e.category).toBe(category);
    expect(e.retryable).toBe(retryable);
  });
});

describe("lane ↔ native board status (D11 projection over the P20 fixed enum)", () => {
  const pairs = [
    ["backlog", "backlog"],
    ["ready_to_work", "todo"],
    ["in_progress", "in_progress"],
    ["waiting_for_feedback", "blocked"],
    ["ready_for_testing", "in_review"],
    ["done", "done"],
    ["cancelled", "cancelled"],
  ] as const;

  it.each(pairs)("projects lane %s onto native %s", (lane, native) => {
    expect(nativeStatusFromLane(lane)).toBe(native);
  });

  it.each(pairs)("maps native %s back to lane %s — a clean 1:1, no ambiguity", (lane, native) => {
    expect(laneFromNativeStatus(native)).toBe(lane);
  });

  it("surfaces an unmapped native board status as unknown, never a neighbor (D8)", () => {
    expect(laneFromNativeStatus("triaging")).toBe("unknown");
  });
});

describe("board actor attribution (P22: every activity entry carries actor_id + actor_type)", () => {
  const self = "member-self-id";

  it("attributes the adapter's own member identity as the conductor", () => {
    expect(actorFrom("member", self, self)).toBe("conductor");
  });

  it("attributes any other member as the operator", () => {
    expect(actorFrom("member", "someone-else", self)).toBe("operator");
  });

  it("attributes agent-driven changes as agent — never a forward signal", () => {
    expect(actorFrom("agent", "agent-id", self)).toBe("agent");
  });

  it("surfaces unmapped actor types as unknown (D8 closed union)", () => {
    expect(actorFrom("system", "x", self)).toBe("unknown");
    expect(actorFrom(undefined, undefined, self)).toBe("unknown");
  });
});

describe("governance ticket markers (D11: gate/idea tickets share the marker namespace)", () => {
  it("round-trips a colon-namespaced marker id", () => {
    const desc = embedEngagementMarker("Approve this plan.", "gate:stage-1:v2");
    expect(extractEngagementId(desc)).toBe("gate:stage-1:v2");
  });
});

describe("marker extraction under marker-shaped plan text", () => {
  it("takes the LAST marker — the trailing one the adapter appended is authoritative", () => {
    const desc = embedEngagementMarker(
      'The brief may discuss markers like <!-- guild:engagement=spoofed-id --> in prose.',
      "eng-real",
    );
    expect(extractEngagementId(desc)).toBe("eng-real");
  });
});
