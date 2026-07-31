/**
 * ExecutionSubstrate port conformance suite (CLAUDE.md TDD rules; load-bearing
 * for D8): one reusable test suite that every substrate adapter must pass —
 * `substrate-multica` today, any fallback adapter tomorrow. Also the substrate
 * conformance gate: mandatory-green on every Multica pin bump and daemon image
 * rebuild (ROADMAP M1b). Scenarios mirror features/execution-substrate.feature.
 *
 * Runs against real infrastructure (the Tier 1 compose stack), never mocks.
 * Spend discipline: work items are created against the cheap model tier and
 * cancelled immediately unless the scenario needs a completion; the single
 * completion scenario runs last.
 */

import { afterAll, describe, expect, it } from "vitest";
import type { ContractVerdict, ExecutionSubstrate, SubstrateEvent, WorkItemRef, WorkItemSpec, WorkItemStatus } from "@guild/shared";
import { isSubstrateError } from "@guild/shared";

export interface ConformanceEnv {
  substrate: ExecutionSubstrate;
  /** scope handed to listWorkItems/watch — e.g. the Multica workspace id */
  projectScope: string;
  /** a role assignable to new work items in this environment */
  role: string;
  /** a role no agent is bound to — must classify as unsupported_capability */
  unknownRole: string;
  /** minimal valid spec with a fresh, unique engagementId per call */
  makeSpec(overrides?: Partial<Omit<WorkItemSpec, "engagementId">>): WorkItemSpec;
  /** same substrate wired with invalid credentials — for auth classification */
  unauthenticatedSubstrate(): ExecutionSubstrate;
  /** optional env introspection beyond the port — enables stronger comment assertions */
  listComments?(ref: WorkItemRef): Promise<Array<{ id: string; body: string; inReplyTo: string | null }>>;
}

const TERMINAL: WorkItemStatus[] = ["done", "failed", "cancelled"];

async function pollUntil(
  substrate: ExecutionSubstrate,
  ref: WorkItemRef,
  accept: (status: WorkItemStatus) => boolean,
  timeoutMs: number,
): Promise<WorkItemStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await substrate.getWorkItem(ref);
    if (accept(snap.status)) return snap.status;
    if (Date.now() > deadline) {
      throw new Error(`timeout: ${ref.externalId} stuck in ${snap.status} (native: ${snap.nativeStatus})`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export function describeExecutionSubstrateConformance(setup: () => Promise<ConformanceEnv>): void {
  describe("ExecutionSubstrate conformance", () => {
    const created: WorkItemRef[] = [];
    let envPromise: Promise<ConformanceEnv> | null = null;
    const env = () => (envPromise ??= setup());

    /** create + register for cleanup */
    async function createItem(e: ConformanceEnv, overrides?: Partial<Omit<WorkItemSpec, "engagementId">>) {
      const spec = e.makeSpec(overrides);
      const ref = await e.substrate.createWorkItem(spec);
      created.push(ref);
      return { spec, ref };
    }

    afterAll(async () => {
      const e = await env();
      for (const ref of created) {
        await e.substrate.cancel(ref, "operator").catch(() => undefined);
        await e.substrate.close(ref).catch(() => undefined);
      }
    });

    it("createWorkItem → findWorkItem round-trips the engagement id (dispatch-saga idempotency)", async () => {
      const e = await env();
      const { spec, ref } = await createItem(e);
      expect(ref.substrate).toBeTruthy();
      expect(await e.substrate.findWorkItem(spec.engagementId)).toEqual(ref);
      await e.substrate.cancel(ref, "operator");
    });

    it("findWorkItem returns null for an engagement that was never dispatched", async () => {
      const e = await env();
      expect(await e.substrate.findWorkItem(`never-${Date.now().toString(36)}`)).toBeNull();
    });

    it("a fresh work item snapshots as assigned and non-terminal", async () => {
      const e = await env();
      const { ref } = await createItem(e);
      const snap = await e.substrate.getWorkItem(ref);
      expect(snap.assignedAgent).toBeTruthy();
      expect(TERMINAL).not.toContain(snap.status);
      await e.substrate.cancel(ref, "operator");
    });

    it("listWorkItems includes created items and only substrate-owned ones", async () => {
      const e = await env();
      const { ref } = await createItem(e);
      const items = await e.substrate.listWorkItems(e.projectScope);
      expect(items.map((s) => s.item.externalId)).toContain(ref.externalId);
      for (const s of items) expect(s.item.substrate).toBe(ref.substrate);
      await e.substrate.cancel(ref, "operator");
    });

    it("cancel reaches a terminal state and repeated cancel is a no-op, never an error", async () => {
      const e = await env();
      const { ref } = await createItem(e);
      await e.substrate.cancel(ref, "operator");
      const status = await pollUntil(e.substrate, ref, (s) => TERMINAL.includes(s), 60_000);
      expect(TERMINAL).toContain(status);
      // terminal-cancel no-op (M1a P4) — conductor retries must be safe
      await e.substrate.cancel(ref, "operator");
      await e.substrate.cancel(ref, "operator");
    });

    it("comment posts top-level and threads via inReplyTo", async () => {
      const e = await env();
      const { ref } = await createItem(e);
      await e.substrate.cancel(ref, "operator");
      await e.substrate.comment(ref, "conformance: top-level comment");
      if (e.listComments) {
        const first = (await e.listComments(ref)).find((c) => c.body.includes("top-level comment"));
        expect(first, "top-level comment visible").toBeTruthy();
        expect(first!.inReplyTo).toBeNull();
        await e.substrate.comment(ref, "conformance: threaded reply", { inReplyTo: first!.id });
        const reply = (await e.listComments(ref)).find((c) => c.body.includes("threaded reply"));
        expect(reply!.inReplyTo).toBe(first!.id);
      }
      await e.substrate.cancel(ref, "operator"); // comments can enqueue new work (P5/P6)
    });

    it("requestRework delivers the verdict's failing criteria as a comment", async () => {
      const e = await env();
      const { spec, ref } = await createItem(e);
      await e.substrate.cancel(ref, "operator");
      const verdict: ContractVerdict = {
        engagementId: spec.engagementId,
        contractId: spec.brief.contract.contractId,
        contractVersion: spec.brief.contract.version,
        commitSha: "0000000000000000000000000000000000000000",
        outcome: "failed",
        checkedAt: new Date().toISOString(),
        results: [
          {
            check: { kind: "artifact", path: "CONFORMANCE.md", mustContain: "ok" },
            outcome: "failed",
            detail: "conformance-fixture: file missing",
          },
        ],
      };
      await e.substrate.requestRework(ref, verdict);
      if (e.listComments) {
        const bounce = (await e.listComments(ref)).find((c) => c.body.includes("conformance-fixture"));
        expect(bounce, "bounce comment visible with failing detail").toBeTruthy();
        expect(bounce!.inReplyTo).toBeNull(); // top-level triggers the agent (P5)
      }
      await e.substrate.cancel(ref, "operator");
    });

    it("close resolves and the item stays readable (close is advisory — P6)", async () => {
      const e = await env();
      const { ref } = await createItem(e);
      await e.substrate.cancel(ref, "operator");
      await e.substrate.close(ref);
      const snap = await e.substrate.getWorkItem(ref);
      expect(snap.item).toEqual(ref);
    });

    it("classifies bad credentials as auth", async () => {
      const e = await env();
      const err = await e
        .unauthenticatedSubstrate()
        .listWorkItems(e.projectScope)
        .catch((x) => x);
      expect(isSubstrateError(err), `expected SubstrateError, got: ${err}`).toBe(true);
      expect(err.category).toBe("auth");
    });

    it("classifies a missing work item as not_found", async () => {
      const e = await env();
      const err = await e.substrate
        .getWorkItem({ substrate: "any", externalId: "00000000-0000-0000-0000-000000000000" })
        .catch((x) => x);
      expect(isSubstrateError(err), `expected SubstrateError, got: ${err}`).toBe(true);
      expect(err.category).toBe("not_found");
    });

    it("classifies an unbound role as unsupported_capability", async () => {
      const e = await env();
      const err = await e.substrate.createWorkItem(e.makeSpec({ role: e.unknownRole })).catch((x) => x);
      expect(isSubstrateError(err), `expected SubstrateError, got: ${err}`).toBe(true);
      expect(err.category).toBe("unsupported_capability");
    });

    it("an agent completes a work item: status events over watch, done snapshot, work report", async () => {
      const e = await env();
      const events: SubstrateEvent[] = [];
      const abort = new AbortController();
      const { ref } = await createItem(e, {
        title: "conformance: completion path",
      });
      const consumer = (async () => {
        for await (const ev of e.substrate.watch(e.projectScope, { signal: abort.signal })) {
          events.push(ev);
          const done =
            ev.kind === "status" &&
            ev.item.externalId === ref.externalId &&
            TERMINAL.includes(ev.status);
          if (done) break;
        }
      })();

      const status = await pollUntil(e.substrate, ref, (s) => TERMINAL.includes(s), 180_000);
      expect(status).toBe("done");

      const snap = await e.substrate.getWorkItem(ref);
      // summary may legitimately be empty (verified live: a reply-style
      // completion can end with no final text) — presence of the report and a
      // usable branch hint are the contract
      expect(snap.report, "work report present after completion").toBeTruthy();
      expect(typeof snap.report?.summary).toBe("string");
      expect(snap.report?.branchHint).toMatch(/^agent\//);

      // give the event stream a moment to flush, then cancel via the signal —
      // aborting closes the transport and wakes a parked stream (port contract)
      await Promise.race([consumer, new Promise((r) => setTimeout(r, 10_000))]);
      abort.abort();
      await consumer;

      const statuses = events
        .filter((ev): ev is Extract<SubstrateEvent, { kind: "status" }> => ev.kind === "status")
        .filter((ev) => ev.item.externalId === ref.externalId)
        .map((ev) => ev.status);
      expect(statuses.length, "status events observed over watch").toBeGreaterThan(0);
      // Normative canary (ARCHITECTURE.md D8): between creation and running
      // there is NO intervening approval or unknown state — every pre-running
      // status maps into the closed pre-execution set. A pin bump that adds a
      // native intermediate state must fail here, not silently map.
      const firstRunning = statuses.indexOf("running");
      const preRunning = firstRunning === -1 ? statuses.filter((s) => !TERMINAL.includes(s)) : statuses.slice(0, firstRunning);
      for (const s of preRunning) {
        expect(s, "pre-running status stays in the closed pre-execution set").toBe("queued");
      }
      const ids = events.map((ev) => ev.eventId);
      expect(new Set(ids).size, "eventIds unique per stream").toBe(ids.length);
    }, 240_000);
  });
}
