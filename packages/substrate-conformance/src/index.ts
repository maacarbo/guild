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
import type { ContractVerdict, ExecutionSubstrate, Lane, SubstrateEvent, WorkItemRef, WorkItemSpec, WorkItemStatus } from "@guild/shared";
import { isSubstrateError } from "@guild/shared";

export interface ConformanceEnv {
  substrate: ExecutionSubstrate;
  /** scope handed to listWorkItems/watch — e.g. the Multica workspace id */
  projectScope: string;
  /** a role assignable to new work items in this environment */
  role: string;
  /** a role no agent is bound to — must classify as unsupported_capability */
  unknownRole: string;
  /** a role safe to hire and retire in this environment (M3 team evolution) */
  hirableRole: string;
  /** the model route hires bind to — the environment's cheap tier */
  hireModel: string;
  /** minimal valid spec with a fresh, unique engagementId per call */
  makeSpec(overrides?: Partial<Omit<WorkItemSpec, "engagementId">>): WorkItemSpec;
  /** same substrate wired with invalid credentials — for auth classification */
  unauthenticatedSubstrate(): ExecutionSubstrate;
  /** the same environment wired as a NEW process: static config only, no carried-over in-memory state (M3 restart contract) */
  freshSubstrate(): ExecutionSubstrate;
}

const TERMINAL: WorkItemStatus[] = ["done", "failed", "cancelled"];

const ALL_LANES: Lane[] = [
  "backlog",
  "ready_to_work",
  "in_progress",
  "waiting_for_feedback",
  "ready_for_testing",
  "done",
  "cancelled",
];

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
      const first = (await e.substrate.listComments(ref)).find((c) => c.body.includes("top-level comment"));
      expect(first, "top-level comment visible").toBeTruthy();
      expect(first!.inReplyTo).toBeNull();
      // the substrate's own comments attribute as the conductor — the same
      // fail-closed mapping the reconcile amend-recovery leans on (#12/D15)
      expect(first!.actor).toBe("conductor");
      await e.substrate.comment(ref, "conformance: threaded reply", { inReplyTo: first!.commentId });
      const reply = (await e.substrate.listComments(ref)).find((c) => c.body.includes("threaded reply"));
      expect(reply!.inReplyTo).toBe(first!.commentId);
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
      const bounce = (await e.substrate.listComments(ref)).find((c) => c.body.includes("conformance-fixture"));
      expect(bounce, "bounce comment visible with failing detail").toBeTruthy();
      expect(bounce!.inReplyTo).toBeNull(); // top-level triggers the agent (P5)
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

    it("createTicket → findWorkItem round-trips the governance marker; a ticket runs nothing (D11)", async () => {
      const e = await env();
      const markerId = `gate:conformance:${Date.now().toString(36)}`;
      const ref = await e.substrate.createTicket({
        markerId,
        title: "conformance: governance ticket",
        body: "Board-control ticket — no agent, no brief, no contract.",
      });
      created.push(ref);
      expect(await e.substrate.findWorkItem(markerId)).toEqual(ref);
      const snap = await e.substrate.getWorkItem(ref);
      expect(snap.assignedAgent, "governance tickets are never assigned").toBeUndefined();
    });

    it("setLane round-trips every lane through the native board — the D11 1:1 projection, idempotently", async () => {
      const e = await env();
      const ref = await e.substrate.createTicket({
        markerId: `lane:conformance:${Date.now().toString(36)}`,
        title: "conformance: lane projection",
        body: "Lane round-trip fixture.",
      });
      created.push(ref);
      for (const lane of ALL_LANES) {
        await e.substrate.setLane(ref, lane);
        expect((await e.substrate.getWorkItem(ref)).lane, `lane ${lane} reads back`).toBe(lane);
      }
      // idempotent re-set is a no-op, never an error
      await e.substrate.setLane(ref, "done");
      await e.substrate.setLane(ref, "done");
    });

    it("a conductor lane move surfaces as lane_moved with conductor attribution (D11 trigger surface)", async () => {
      // operator attribution needs a second member identity, which a
      // single-credential environment cannot mint — the actor translation is
      // unit-tested adapter-side (P22); the wire mechanics are proven here.
      const e = await env();
      const ref = await e.substrate.createTicket({
        markerId: `move:conformance:${Date.now().toString(36)}`,
        title: "conformance: lane move event",
        body: "Lane-move event fixture.",
      });
      created.push(ref);
      const events: SubstrateEvent[] = [];
      const abort = new AbortController();
      const consumer = (async () => {
        for await (const ev of e.substrate.watch(e.projectScope, { signal: abort.signal })) {
          events.push(ev);
          if (ev.kind === "lane_moved" && ev.item.externalId === ref.externalId) break;
        }
      })();
      await new Promise((r) => setTimeout(r, 2000)); // let the socket authenticate
      await e.substrate.setLane(ref, "waiting_for_feedback");
      await Promise.race([consumer, new Promise((r) => setTimeout(r, 30_000))]);
      abort.abort();
      await consumer;
      const move = events.find(
        (ev): ev is Extract<SubstrateEvent, { kind: "lane_moved" }> =>
          ev.kind === "lane_moved" && ev.item.externalId === ref.externalId,
      );
      expect(move, "lane_moved observed over watch").toBeTruthy();
      expect(move!.lane).toBe("waiting_for_feedback");
      expect(move!.nativeStatus).toBeTruthy();
      expect(move!.actor).toBe("conductor");
    }, 60_000);

    it("snapshots carry content, creator, and marker surfaces (D12 idea-detection reads)", async () => {
      // creator attribution: the suite's single credential IS the adapter's own
      // identity, so createdBy must read "conductor" — operator attribution is
      // unit-tested adapter-side (P25: creator_id shares the actor id space)
      const e = await env();
      const markerId = `content:conformance:${Date.now().toString(36)}`;
      const body = "Content-surface fixture — the planner reads ideas from snapshots.";
      const ref = await e.substrate.createTicket({ markerId, title: "conformance: content surfaces", body });
      created.push(ref);
      const snap = await e.substrate.getWorkItem(ref);
      expect(snap.title).toBe("conformance: content surfaces");
      expect(snap.body, "body carries the authored text (marker may be appended)").toContain(body);
      expect(snap.createdBy).toBe("conductor");
      expect(snap.markerId, "the embedded marker is exposed — absence marks an idea candidate").toBe(markerId);
      const listed = (await e.substrate.listWorkItems(e.projectScope)).find(
        (s) => s.item.externalId === ref.externalId,
      );
      expect(listed?.markerId, "the list read exposes the same marker").toBe(markerId);
    });

    it("item creation surfaces as item_created with creator attribution (D12 idea trigger)", async () => {
      const e = await env();
      const events: SubstrateEvent[] = [];
      const abort = new AbortController();
      let ref: WorkItemRef | undefined;
      const consumer = (async () => {
        for await (const ev of e.substrate.watch(e.projectScope, { signal: abort.signal })) {
          events.push(ev);
          if (ev.kind === "item_created" && ev.item.externalId === ref?.externalId) break;
        }
      })();
      await new Promise((r) => setTimeout(r, 2000)); // let the socket authenticate
      ref = await e.substrate.createTicket({
        markerId: `birth:conformance:${Date.now().toString(36)}`,
        title: "conformance: creation event",
        body: "Creation-event fixture.",
      });
      created.push(ref);
      await Promise.race([consumer, new Promise((r) => setTimeout(r, 30_000))]);
      abort.abort();
      await consumer;
      const birth = events.find(
        (ev): ev is Extract<SubstrateEvent, { kind: "item_created" }> =>
          ev.kind === "item_created" && ev.item.externalId === ref!.externalId,
      );
      expect(birth, "item_created observed over watch").toBeTruthy();
      expect(birth!.title).toBe("conformance: creation event");
      expect(birth!.createdBy).toBe("conductor");
      expect(birth!.at).toBeTruthy();
    }, 60_000);

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

    it("hire makes a role dispatchable; retire withdraws it one-way; history survives (M3)", async () => {
      const e = await env();
      const agentName = `conf-hire-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const hired = await e.substrate.hireAgent({ role: e.hirableRole, agentName, model: e.hireModel });
      expect(hired.hired).toBe(true);
      // idempotent: a bound role no-ops
      expect(await e.substrate.hireAgent({ role: e.hirableRole, agentName, model: e.hireModel })).toEqual({
        hired: false,
        agentId: hired.agentId,
      });
      const ref = await e.substrate.createWorkItem(e.makeSpec({ role: e.hirableRole }));
      await e.substrate.cancel(ref, "operator");
      const retired = await e.substrate.retireAgent(e.hirableRole);
      expect(retired).toEqual({ retired: true, agentId: hired.agentId });
      const err = await e.substrate.createWorkItem(e.makeSpec({ role: e.hirableRole })).catch((x) => x);
      expect(err.category, "retired role is unbound again").toBe("unsupported_capability");
      // the retired agent's historical item stays readable — reconcile reads every item
      const snap = await e.substrate.getWorkItem(ref);
      expect(snap.item).toEqual(ref);
      expect(await e.substrate.retireAgent(e.hirableRole), "retire is idempotent").toEqual({ retired: false });
    });

    it("retire converges across a process restart via the trail hint (M3)", async () => {
      const e = await env();
      const agentName = `conf-restart-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const hired = await e.substrate.hireAgent({ role: e.hirableRole, agentName, model: e.hireModel });
      expect(hired.hired).toBe(true);
      // a NEW process holds no binding for the hire — the governance-trail
      // hint must still retire it, never leak the agent or no-op silently
      const fresh = e.freshSubstrate();
      expect(await fresh.retireAgent(e.hirableRole, { agentId: hired.agentId })).toEqual({
        retired: true,
        agentId: hired.agentId,
      });
      // crash-redrive: already archived still owes the caller its decision
      expect(await e.freshSubstrate().retireAgent(e.hirableRole, { agentId: hired.agentId })).toEqual({
        retired: true,
        agentId: hired.agentId,
      });
    });

    it("bindEngagementKey routes a role through the given credential — idempotent; an unbound role classifies (D2, audit tdd-4)", async () => {
      const e = await env();
      // a disposable hire of its own: binding must never touch the shared
      // worker agent's env — the completion scenario still needs a WORKING key
      const agentName = `conf-bind-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      await e.substrate.hireAgent({ role: e.hirableRole, agentName, model: e.hireModel });
      await e.substrate.bindEngagementKey(e.hirableRole, "conf-key-bind-1");
      // re-bind of the same key is a no-op, never an error (dispatch-saga re-drive)
      await e.substrate.bindEngagementKey(e.hirableRole, "conf-key-bind-1");
      try {
        await e.substrate.bindEngagementKey(e.unknownRole, "conf-key-bind-2");
        expect.unreachable("binding an unbound role must classify, not succeed");
      } catch (err) {
        expect(isSubstrateError(err), "a classified SubstrateError").toBe(true);
        if (isSubstrateError(err)) expect(err.category).toBe("unsupported_capability");
      }
      // leave the environment as found
      await e.substrate.retireAgent(e.hirableRole, {});
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
