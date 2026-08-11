/**
 * Reusable GovernanceStore contract suite (#12 item 5): pins the CAS and
 * first-writer-wins semantics every store adapter must honor (#11). The
 * in-memory adapter runs it in CI; the Postgres adapter runs it live-gated.
 * Keys are salted per run because the pg suite truncates once per process,
 * not per test.
 */

import { describe, expect, it } from "vitest";
import type { GovernanceStore } from "../ports/governance-store.js";

export function governanceStoreContract(name: string, getStore: () => GovernanceStore): void {
  const salt = Math.random().toString(36).slice(2, 8);
  const key = (s: string) => `${s}-${salt}`;

  describe(`${name}: GovernanceStore contract (#11 CAS/uniqueness)`, () => {
    it("saveEngagementIf refuses to create: a missing record is a lost CAS, not an upsert", async () => {
      const store = getStore();
      const id = key("eng-missing");
      expect(
        await store.saveEngagementIf(
          { engagementId: id, stageId: key("s"), planVersion: 1, bounceCount: 0, state: "dispatched" },
          "gated",
        ),
      ).toBe(false);
      expect(await store.getEngagement(id)).toBeNull();
    });

    it("saveEngagementIf is a state CAS: the matching writer wins, the stale writer loses and changes nothing", async () => {
      const store = getStore();
      const base = { engagementId: key("eng-cas"), stageId: key("s"), planVersion: 1, bounceCount: 0 } as const;
      await store.saveEngagement({ ...base, state: "gated" });
      expect(await store.saveEngagementIf({ ...base, state: "dispatched" }, "gated")).toBe(true);
      expect(await store.saveEngagementIf({ ...base, state: "working" }, "gated"), "stale expectation").toBe(false);
      expect((await store.getEngagement(base.engagementId))?.state).toBe("dispatched");
    });

    it("gate decisions are first-writer-wins per (stageId, planVersion); losers read what stuck", async () => {
      const store = getStore();
      const stageId = key("s-gd");
      const approved = { kind: "approved", stageId, planVersion: 1, by: "operator", at: "t1" } as const;
      const rejected = { kind: "rejected", stageId, planVersion: 1, note: "late", at: "t2" } as const;
      expect(await store.recordGateDecision(approved)).toBe(true);
      expect(await store.recordGateDecision(rejected), "second decision loses").toBe(false);
      expect(await store.recordGateDecision({ ...approved, planVersion: 2 }), "a new version regates").toBe(true);
      expect((await store.getGateDecision(stageId, 1))?.kind, "the loser sees the winner").toBe("approved");
      expect(await store.getGateDecision(stageId, 9)).toBeNull();
    });
  });
}
