import { describe, expect, it } from "vitest";
import {
  branchHintFor,
  classifyFailure,
  classifyHttpError,
  embedEngagementMarker,
  extractEngagementId,
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
