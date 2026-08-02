import { describe, expect, it } from "vitest";
import type {
  BoardActor,
  ContractVerdict,
  EngagementKey,
  KeySpend,
  ExecutionSubstrate,
  Lane,
  ModelGateway,
  StagePlan,
  SubstrateEvent,
  TicketSpec,
  WorkItemRef,
  WorkItemSnapshot,
  WorkItemSpec,
  WorkItemStatus,
} from "@guild/shared";
import { MAX_BOUNCES } from "@guild/shared";
import { InMemoryGovernanceStore } from "../adapters/in-memory-governance-store.js";
import type { ValidationInput } from "./contract-validator.js";
import { Conductor } from "./conductor.js";

/** shared op log so cross-dependency ordering (bind-before-create) is assertable */
type OpLog = string[];

class FakeSubstrate implements ExecutionSubstrate {
  readonly name = "fake";
  private seq = 0;
  items = new Map<string, { markerId: string; title: string; lane: Lane; assigned?: string }>();
  /** per-item snapshot overrides (status, report) the tests script */
  snapshots = new Map<string, Partial<WorkItemSnapshot>>();
  laneLog: Array<{ id: string; lane: Lane }> = [];
  comments: Array<{ id: string; body: string }> = [];
  reworks: Array<{ id: string; verdict: ContractVerdict }> = [];
  boundKeys: Array<{ role: string; key: string }> = [];
  cancels: string[] = [];
  closes: string[] = [];

  constructor(private readonly ops: OpLog) {}

  private ref(id: string): WorkItemRef {
    return { substrate: this.name, externalId: id };
  }
  async createWorkItem(spec: WorkItemSpec): Promise<WorkItemRef> {
    this.ops.push("createWorkItem");
    const id = `item-${++this.seq}`;
    this.items.set(id, { markerId: spec.engagementId, title: spec.title, lane: "backlog", assigned: spec.role });
    return this.ref(id);
  }
  async createTicket(spec: TicketSpec): Promise<WorkItemRef> {
    this.ops.push("createTicket");
    const id = `ticket-${++this.seq}`;
    this.items.set(id, { markerId: spec.markerId, title: spec.title, lane: "backlog" });
    return this.ref(id);
  }
  async findWorkItem(markerId: string): Promise<WorkItemRef | null> {
    for (const [id, item] of this.items) if (item.markerId === markerId) return this.ref(id);
    return null;
  }
  async getWorkItem(item: WorkItemRef): Promise<WorkItemSnapshot> {
    const it = this.items.get(item.externalId);
    if (!it) throw new Error(`no item ${item.externalId}`);
    return {
      item,
      status: "queued",
      lane: it.lane,
      updatedAt: "2026-08-02T00:00:00Z",
      ...(it.assigned ? { assignedAgent: it.assigned } : {}),
      ...this.snapshots.get(item.externalId),
    };
  }
  async listWorkItems(): Promise<WorkItemSnapshot[]> {
    return Promise.all([...this.items.keys()].map((id) => this.getWorkItem(this.ref(id))));
  }
  async assign(): Promise<void> {}
  async bindEngagementKey(role: string, key: string): Promise<void> {
    this.ops.push("bindEngagementKey");
    this.boundKeys.push({ role, key });
  }
  async setLane(item: WorkItemRef, lane: Lane): Promise<void> {
    const it = this.items.get(item.externalId);
    if (it) it.lane = lane;
    this.laneLog.push({ id: item.externalId, lane });
  }
  async comment(item: WorkItemRef, body: string): Promise<void> {
    this.comments.push({ id: item.externalId, body });
  }
  async requestRework(item: WorkItemRef, verdict: ContractVerdict): Promise<void> {
    this.reworks.push({ id: item.externalId, verdict });
  }
  async cancel(item: WorkItemRef): Promise<void> {
    this.cancels.push(item.externalId);
  }
  async close(item: WorkItemRef): Promise<void> {
    this.closes.push(item.externalId);
  }
  // eslint-disable-next-line require-yield
  async *watch(): AsyncIterable<SubstrateEvent> {
    return;
  }
}

class FakeGateway implements ModelGateway {
  mints: Array<{ engagementId: string; budgetCents: number }> = [];
  revokes: string[] = [];
  constructor(private readonly ops: OpLog) {}
  async mintKey(engagementId: string, budgetCents: number): Promise<EngagementKey> {
    this.ops.push("mintKey");
    this.mints.push({ engagementId, budgetCents });
    return { engagementId, key: `sk-${engagementId}`, budgetCents };
  }
  async revokeKey(engagementId: string): Promise<void> {
    this.revokes.push(engagementId);
  }
  async getSpend(engagementId: string): Promise<KeySpend> {
    return { engagementId, spentCents: 0, budgetCents: 0, exhausted: false };
  }
}

class FakeValidator {
  outcomes: Array<ContractVerdict["outcome"]> = [];
  inputs: ValidationInput[] = [];
  async validate(input: ValidationInput): Promise<ContractVerdict> {
    this.inputs.push(input);
    return {
      engagementId: input.engagementId,
      contractId: input.contract.contractId,
      contractVersion: input.contract.version,
      commitSha: input.commitSha,
      outcome: this.outcomes.shift() ?? "passed",
      checkedAt: "2026-08-02T00:00:00Z",
      results: [],
    };
  }
}

class FakeSource {
  shas = new Map<string, string>();
  ffs: Array<{ targetBranch: string; sha: string }> = [];
  async resolveRemoteSha(_repoUrl: string, branch: string): Promise<string | null> {
    return this.shas.get(branch) ?? null;
  }
  async fastForward(_repoUrl: string, targetBranch: string, sha: string): Promise<void> {
    this.ffs.push({ targetBranch, sha });
  }
}

const plan: StagePlan = {
  projectId: "proj-1",
  stageId: "stage-1",
  planVersion: 1,
  kind: "implementation",
  objective: "prove the governed path",
  engagements: [
    {
      engagementId: "eng-1",
      role: "implementer",
      title: "do the governed work",
      budgetCents: 500,
      brief: {
        roleContext: "",
        instructions: "work",
        contract: { contractId: "c-1", version: 1, authoredBy: "architect", gherkin: "Feature: x", checks: [] },
        priorDecisions: [],
        artifactRefs: [],
        constraints: [],
      },
    },
  ],
  budgetCents: 500,
};

function makeWorld() {
  const ops: OpLog = [];
  const substrate = new FakeSubstrate(ops);
  const gateway = new FakeGateway(ops);
  const validator = new FakeValidator();
  const source = new FakeSource();
  const store = new InMemoryGovernanceStore();
  const conductor = new Conductor(plan, {
    substrate,
    gateway,
    validator,
    source,
    store,
    now: () => "2026-08-02T00:00:00Z",
  }, {
    projectScope: "ws-1",
    repoUrl: "git@example.com:owner/product.git",
    targetBranch: "main",
  });
  return { ops, substrate, gateway, validator, source, store, conductor };
}

let evSeq = 0;
const laneMove = (item: WorkItemRef, lane: Lane, actor: BoardActor): SubstrateEvent => ({
  kind: "lane_moved",
  eventId: `ev-${++evSeq}`,
  item,
  lane,
  nativeStatus: lane,
  actor,
  at: "2026-08-02T00:00:00Z",
});
const statusEv = (item: WorkItemRef, status: WorkItemStatus): SubstrateEvent => ({
  kind: "status",
  eventId: `ev-${++evSeq}`,
  item,
  status,
  at: "2026-08-02T00:00:00Z",
});
const commentEv = (item: WorkItemRef, actor: BoardActor): SubstrateEvent => ({
  kind: "comment",
  eventId: `ev-${++evSeq}`,
  commentId: `c-${evSeq}`,
  item,
  author: actor,
  actor,
  body: "text",
  at: "2026-08-02T00:00:00Z",
});

type World = ReturnType<typeof makeWorld>;

async function postAndApprove(w: World): Promise<{ gate: WorkItemRef; item: WorkItemRef }> {
  const gate = await w.conductor.postStageForApproval();
  await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
  const item = await w.substrate.findWorkItem("eng-1");
  expect(item, "engagement work item dispatched").toBeTruthy();
  return { gate, item: item! };
}

async function driveToReported(w: World, over: Partial<WorkItemSnapshot> = {}) {
  const { item } = await postAndApprove(w);
  await w.conductor.handleEvent(statusEv(item, "running"));
  w.substrate.snapshots.set(item.externalId, {
    status: "done",
    report: { summary: "did it", branchHint: "agent/worker/abc12345" },
    ...over,
  });
  w.source.shas.set("agent/worker/abc12345", "sha-validated");
  await w.conductor.handleEvent(statusEv(item, "done"));
  return { item };
}

describe("gate flow (D11: the operator's lane move is the approval)", () => {
  it("posting a stage creates the gate ticket in waiting-for-feedback and gates the engagements", async () => {
    const w = makeWorld();
    const gate = await w.conductor.postStageForApproval();
    expect((await w.substrate.getWorkItem(gate)).lane).toBe("waiting_for_feedback");
    expect(await w.substrate.findWorkItem("gate:stage-1:v1")).toEqual(gate);
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("gated");
    const kinds = (await w.store.listDecisions()).map((d) => d.kind);
    expect(kinds).toContain("gate_posted");
  });

  it("posting twice is idempotent — one ticket, one gate_posted decision", async () => {
    const w = makeWorld();
    const first = await w.conductor.postStageForApproval();
    const second = await w.conductor.postStageForApproval();
    expect(second).toEqual(first);
    expect(w.substrate.items.size).toBe(1);
    const posted = (await w.store.listDecisions()).filter((d) => d.kind === "gate_posted");
    expect(posted).toHaveLength(1);
  });

  it("an operator move to ready-to-work dispatches: key minted and bound BEFORE the item exists", async () => {
    const w = makeWorld();
    await postAndApprove(w);
    expect(w.gateway.mints).toEqual([{ engagementId: "eng-1", budgetCents: 500 }]);
    expect(w.substrate.boundKeys).toEqual([{ role: "implementer", key: "sk-eng-1" }]);
    // assignment dispatches immediately (P6): a late bind leaks spend onto the old key
    expect(w.ops.indexOf("bindEngagementKey")).toBeLessThan(w.ops.indexOf("createWorkItem"));
    const item = (await w.substrate.findWorkItem("eng-1"))!;
    expect((await w.substrate.getWorkItem(item)).lane).toBe("ready_to_work");
    const rec = await w.store.getEngagement("eng-1");
    expect(rec?.state).toBe("dispatched");
    expect(rec?.item).toEqual(item);
    expect(await w.store.listDispatchIntents()).toContain("eng-1");
  });

  it("moves the gate ticket to done once the stage is dispatched", async () => {
    const w = makeWorld();
    const { gate } = await postAndApprove(w);
    expect((await w.substrate.getWorkItem(gate)).lane).toBe("done");
  });

  it("ignores the conductor's own lane-move echo — no re-dispatch", async () => {
    const w = makeWorld();
    const gate = await w.conductor.postStageForApproval();
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "conductor"));
    expect(w.gateway.mints).toHaveLength(0);
  });

  it("ignores an agent moving the gate ticket — agents cannot approve plans", async () => {
    const w = makeWorld();
    const gate = await w.conductor.postStageForApproval();
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "agent"));
    expect(w.gateway.mints).toHaveLength(0);
  });

  it("an operator cancelling the gate ticket rejects the stage — engagements cancelled, nothing dispatched", async () => {
    const w = makeWorld();
    const gate = await w.conductor.postStageForApproval();
    await w.conductor.handleEvent(laneMove(gate, "cancelled", "operator"));
    expect(w.gateway.mints).toHaveLength(0);
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("cancelled");
    const kinds = (await w.store.listDecisions()).map((d) => d.kind);
    expect(kinds).toContain("termination");
  });
});

describe("work lifecycle", () => {
  it("task running moves the engagement to working and the ticket to in-progress", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w);
    await w.conductor.handleEvent(statusEv(item, "running"));
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("working");
    expect((await w.substrate.getWorkItem(item)).lane).toBe("in_progress");
  });

  it("a completed task validates SHA-pinned; a passing verdict awaits acceptance in waiting-for-feedback", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w);
    expect(w.validator.inputs).toHaveLength(1);
    expect(w.validator.inputs[0]!.commitSha).toBe("sha-validated");
    const rec = await w.store.getEngagement("eng-1");
    expect(rec?.state).toBe("validated");
    expect(rec?.validatedSha).toBe("sha-validated");
    const lanes = w.substrate.laneLog.filter((l) => l.id === item.externalId).map((l) => l.lane);
    expect(lanes).toContain("ready_for_testing");
    expect(lanes.at(-1)).toBe("waiting_for_feedback");
  });

  it("a failing verdict bounces: rework comment with the verdict, ticket back in the go lane", async () => {
    const w = makeWorld();
    w.validator.outcomes = ["failed"];
    const { item } = await driveToReported(w);
    const rec = await w.store.getEngagement("eng-1");
    expect(rec?.state).toBe("bounced");
    expect(rec?.bounceCount).toBe(1);
    expect(w.substrate.reworks).toHaveLength(1);
    expect(w.substrate.reworks[0]!.verdict.outcome).toBe("failed");
    expect((await w.substrate.getWorkItem(item)).lane).toBe("ready_to_work");
  });

  it("a hollow completion — no branch pushed — is a failed verdict, never a pass and never a validator run", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w, { report: { summary: "all done boss" } });
    expect(w.validator.inputs).toHaveLength(0);
    const rec = await w.store.getEngagement("eng-1");
    expect(rec?.state).toBe("bounced");
    expect(w.substrate.reworks[0]!.verdict.outcome).toBe("failed");
    expect((await w.substrate.getWorkItem(item)).lane).toBe("ready_to_work");
  });

  it(`escalates past ${MAX_BOUNCES} bounces: key revoked, ticket held for the operator, no rework`, async () => {
    const w = makeWorld();
    w.validator.outcomes = ["failed"];
    const { item } = await postAndApprove(w);
    const rec = (await w.store.getEngagement("eng-1"))!;
    await w.store.saveEngagement({ ...rec, bounceCount: MAX_BOUNCES });
    await w.conductor.handleEvent(statusEv(item, "running"));
    w.substrate.snapshots.set(item.externalId, {
      status: "done",
      report: { summary: "s", branchHint: "agent/worker/abc12345" },
    });
    w.source.shas.set("agent/worker/abc12345", "sha-x");
    await w.conductor.handleEvent(statusEv(item, "done"));
    const after = await w.store.getEngagement("eng-1");
    expect(after?.state).toBe("escalated");
    expect(w.substrate.reworks).toHaveLength(0);
    expect(w.gateway.revokes).toContain("eng-1");
    expect((await w.substrate.getWorkItem(item)).lane).toBe("waiting_for_feedback");
    const term = (await w.store.listDecisions()).find((d) => d.kind === "termination");
    expect(term).toMatchObject({ terminated: { finalState: "escalated" } });
  });

  it("a validator error keeps the engagement in ready-for-testing and never bounces the work", async () => {
    const w = makeWorld();
    w.validator.outcomes = ["validator_error"];
    const { item } = await driveToReported(w);
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("reported");
    expect(w.substrate.reworks).toHaveLength(0);
    expect((await w.substrate.getWorkItem(item)).lane).toBe("ready_for_testing");
  });
});

describe("acceptance and termination (D6: ff-only to exactly the validated SHA)", () => {
  it("operator acceptance fast-forwards to the validated SHA and runs the termination protocol", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w);
    await w.conductor.handleEvent(laneMove(item, "done", "operator"));
    expect(w.source.ffs).toEqual([{ targetBranch: "main", sha: "sha-validated" }]);
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("accepted");
    expect(w.gateway.revokes).toContain("eng-1");
    expect(w.substrate.closes).toContain(item.externalId);
    const term = (await w.store.listDecisions()).find((d) => d.kind === "termination");
    expect(term).toMatchObject({ terminated: { finalState: "accepted" } });
  });

  it("ignores an agent moving its own ticket to done — validation verdicts are the only forward path", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w);
    await w.conductor.handleEvent(laneMove(item, "done", "agent"));
    expect(w.source.ffs).toHaveLength(0);
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("dispatched");
  });

  it("an operator cancelling an engagement ticket cancels the work and terminates", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w);
    await w.conductor.handleEvent(statusEv(item, "running"));
    await w.conductor.handleEvent(laneMove(item, "cancelled", "operator"));
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("cancelled");
    expect(w.substrate.cancels).toContain(item.externalId);
    expect(w.gateway.revokes).toContain("eng-1");
    expect(w.substrate.closes).toContain(item.externalId);
  });
});

describe("questions and blockers", () => {
  it("an agent question blocks the engagement; the operator's answer resumes it", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w);
    await w.conductor.handleEvent(statusEv(item, "running"));
    w.substrate.snapshots.set(item.externalId, { status: "running" });
    await w.conductor.handleEvent(commentEv(item, "agent"));
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("blocked");
    expect((await w.substrate.getWorkItem(item)).lane).toBe("waiting_for_feedback");
    await w.conductor.handleEvent(commentEv(item, "operator"));
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("working");
    expect((await w.substrate.getWorkItem(item)).lane).toBe("in_progress");
  });

  it("an agent's completion comment is not a question — a terminal snapshot wins the race", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w);
    await w.conductor.handleEvent(statusEv(item, "running"));
    w.substrate.snapshots.set(item.externalId, { status: "done" });
    await w.conductor.handleEvent(commentEv(item, "agent"));
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("working");
  });

  it("ignores the conductor's own comments — briefs and bounces are not blockers", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w);
    await w.conductor.handleEvent(statusEv(item, "running"));
    await w.conductor.handleEvent(commentEv(item, "conductor"));
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("working");
  });
});
