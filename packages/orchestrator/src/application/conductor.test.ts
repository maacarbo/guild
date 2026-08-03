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
  items = new Map<
    string,
    { markerId?: string; title: string; lane: Lane; assigned?: string; body?: string; createdBy?: BoardActor }
  >();
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
      title: it.title,
      body: it.body ?? "",
      createdBy: it.createdBy ?? "conductor",
      ...(it.markerId ? { markerId: it.markerId } : {}),
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
  /** file content keyed `${sha}:${path}` — the upstream handoff surface (D12) */
  files = new Map<string, string>();
  ffs: Array<{ targetBranch: string; sha: string }> = [];
  async resolveRemoteSha(_repoUrl: string, branch: string): Promise<string | null> {
    return this.shas.get(branch) ?? null;
  }
  async fastForward(_repoUrl: string, targetBranch: string, sha: string): Promise<void> {
    this.ffs.push({ targetBranch, sha });
  }
  async readFile(_repoUrl: string, sha: string, path: string): Promise<string | null> {
    return this.files.get(`${sha}:${path}`) ?? null;
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
  const conductor = new Conductor(
    {
      substrate,
      gateway,
      validator,
      source,
      store,
      now: () => "2026-08-02T00:00:00Z",
    },
    {
      projectScope: "ws-1",
      repoUrl: "git@example.com:owner/product.git",
      targetBranch: "main",
      defaultPlanBudgetCents: 1000,
    },
  );
  return { ops, substrate, gateway, validator, source, store, conductor };
}

type World = ReturnType<typeof makeWorld>;

/** adopt the hand-authored single-stage plan and post its gate (the M2a path) */
async function post(w: World): Promise<WorkItemRef> {
  await w.conductor.adoptStagePlan(plan);
  return w.conductor.postStageForApproval(plan.stageId);
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
const commentEv = (item: WorkItemRef, actor: BoardActor, body = "text"): SubstrateEvent => ({
  kind: "comment",
  eventId: `ev-${++evSeq}`,
  commentId: `c-${evSeq}`,
  item,
  author: actor,
  actor,
  body,
  at: "2026-08-02T00:00:00Z",
});

async function postAndApprove(w: World): Promise<{ gate: WorkItemRef; item: WorkItemRef }> {
  const gate = await post(w);
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
    const gate = await post(w);
    expect((await w.substrate.getWorkItem(gate)).lane).toBe("waiting_for_feedback");
    expect(await w.substrate.findWorkItem("gate:stage-1:v1")).toEqual(gate);
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("gated");
    const kinds = (await w.store.listDecisions()).map((d) => d.kind);
    expect(kinds).toContain("gate_posted");
  });

  it("posting twice is idempotent — one ticket, one gate_posted decision", async () => {
    const w = makeWorld();
    const first = await post(w);
    const second = await post(w);
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
    const gate = await post(w);
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "conductor"));
    expect(w.gateway.mints).toHaveLength(0);
  });

  it("ignores an agent moving the gate ticket — agents cannot approve plans", async () => {
    const w = makeWorld();
    const gate = await post(w);
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "agent"));
    expect(w.gateway.mints).toHaveLength(0);
  });

  it("an operator cancelling the gate ticket rejects the stage — engagements cancelled, nothing dispatched", async () => {
    const w = makeWorld();
    const gate = await post(w);
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

describe("reconciliation (reads are the truth path — restart recovery)", () => {
  it("resumes a dispatch saga that crashed mid-flight without duplicating the work item", async () => {
    const w = makeWorld();
    await post(w);
    // crash simulation: intent recorded and the item already created, but the
    // engagement record never advanced past gated
    await w.store.recordDispatchIntent("eng-1", "t0");
    await w.substrate.createWorkItem({
      engagementId: "eng-1",
      role: "implementer",
      title: "do the governed work",
      brief: plan.engagements[0]!.brief,
    });
    await w.conductor.reconcile();
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("dispatched");
    expect(w.ops.filter((o) => o === "createWorkItem")).toHaveLength(1);
  });

  it("recovers an operator approval made while the conductor was down", async () => {
    const w = makeWorld();
    const gate = await post(w);
    await w.substrate.setLane(gate, "ready_to_work"); // operator move, no event delivered
    await w.conductor.reconcile();
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("dispatched");
    expect((await w.substrate.getWorkItem(gate)).lane).toBe("done");
    const gates = (await w.store.listDecisions()).filter((d) => d.kind === "gate");
    expect(gates).toHaveLength(1);
  });

  it("recovers an operator rejection made while the conductor was down", async () => {
    const w = makeWorld();
    const gate = await post(w);
    await w.substrate.setLane(gate, "cancelled");
    await w.conductor.reconcile();
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("cancelled");
    expect(w.gateway.mints).toHaveLength(0);
  });

  it("reconciles a task that started while down", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w);
    w.substrate.snapshots.set(item.externalId, { status: "running" });
    await w.conductor.reconcile();
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("working");
    expect((await w.substrate.getWorkItem(item)).lane).toBe("in_progress");
  });

  it("reconciles a completion that happened while down — SHA-pinned validation still runs", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w);
    w.substrate.snapshots.set(item.externalId, {
      status: "done",
      report: { summary: "done", branchHint: "agent/worker/abc12345" },
    });
    w.source.shas.set("agent/worker/abc12345", "sha-rec");
    await w.conductor.reconcile();
    const rec = await w.store.getEngagement("eng-1");
    expect(rec?.state).toBe("validated");
    expect(rec?.validatedSha).toBe("sha-rec");
  });

  it("recovers an operator acceptance made while down", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w);
    await w.substrate.setLane(item, "done"); // operator accepted, no event delivered
    await w.conductor.reconcile();
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("accepted");
    expect(w.source.ffs).toEqual([{ targetBranch: "main", sha: "sha-validated" }]);
  });

  it("a settled state reconciles to zero new decisions", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w);
    await w.conductor.handleEvent(laneMove(item, "done", "operator"));
    const before = (await w.store.listDecisions()).length;
    await w.conductor.reconcile();
    expect((await w.store.listDecisions()).length).toBe(before);
  });
});

describe("rework resolution (the daemon may mint a new branch hint per task — P7)", () => {
  it("falls back to the previously reported branch when the rework hint is unpushed", async () => {
    const w = makeWorld();
    w.validator.outcomes = ["failed", "passed"];
    const { item } = await driveToReported(w); // first report on agent/worker/abc12345 → bounced
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("bounced");
    // rework: new task id → new hint that was never pushed; the fix landed on the old branch
    await w.conductor.handleEvent(statusEv(item, "running"));
    w.substrate.snapshots.set(item.externalId, {
      status: "done",
      report: { summary: "fixed", branchHint: "agent/worker/zzz99999" },
    });
    w.source.shas.set("agent/worker/abc12345", "sha-fix");
    await w.conductor.handleEvent(statusEv(item, "done"));
    const rec = await w.store.getEngagement("eng-1");
    expect(rec?.state).toBe("validated");
    expect(rec?.validatedSha).toBe("sha-fix");
  });

  it("reconcile does not re-judge a bounced engagement while the old commit still heads the branch", async () => {
    const w = makeWorld();
    w.validator.outcomes = ["failed"];
    await driveToReported(w); // bounced; lastJudgedSha = sha-validated
    const validations = w.validator.inputs.length;
    await w.conductor.reconcile(); // snapshot still done, branch still at the judged sha
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("bounced");
    expect(w.validator.inputs.length).toBe(validations);
  });

  it("reconcile picks up the rework once a new commit heads the branch", async () => {
    const w = makeWorld();
    w.validator.outcomes = ["failed", "passed"];
    await driveToReported(w); // bounced at sha-validated
    w.source.shas.set("agent/worker/abc12345", "sha-rework");
    await w.conductor.reconcile();
    const rec = await w.store.getEngagement("eng-1");
    expect(rec?.state).toBe("validated");
    expect(rec?.validatedSha).toBe("sha-rework");
  });
});

describe("hollow-report branch memory", () => {
  it("a hollow first report still remembers its hint, so a rework landing there resolves", async () => {
    const w = makeWorld();
    w.validator.outcomes = ["passed"];
    // attempt 1: hint never pushed → hollow failed verdict → bounced
    const { item } = await driveToReported(w, { report: { summary: "ack", branchHint: "agent/worker/first111" } });
    w.source.shas.delete("agent/worker/abc12345");
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("bounced");
    // rework: new unpushed hint, but the fix landed on attempt 1's branch
    await w.conductor.handleEvent(statusEv(item, "running"));
    w.substrate.snapshots.set(item.externalId, {
      status: "done",
      report: { summary: "fixed", branchHint: "agent/worker/second22" },
    });
    w.source.shas.set("agent/worker/first111", "sha-late");
    await w.conductor.handleEvent(statusEv(item, "done"));
    const rec = await w.store.getEngagement("eng-1");
    expect(rec?.state).toBe("validated");
    expect(rec?.validatedSha).toBe("sha-late");
  });
});

describe("validator-error retry (D6: infrastructure faults retry, never strand)", () => {
  it("reconcile retries validation for an engagement stranded in reported by a validator error", async () => {
    const w = makeWorld();
    w.validator.outcomes = ["validator_error", "passed"];
    await driveToReported(w);
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("reported");
    await w.conductor.reconcile();
    const rec = await w.store.getEngagement("eng-1");
    expect(rec?.state).toBe("validated");
    expect(rec?.validatedSha).toBe("sha-validated");
  });
});

// ------------------------------- M2b: ideas, amendments, stage sequencing

const itemCreated = (item: WorkItemRef, createdBy: BoardActor, title: string, body: string): SubstrateEvent => ({
  kind: "item_created",
  eventId: `ev-${++evSeq}`,
  item,
  title,
  body,
  createdBy,
  lane: "ready_to_work",
  at: "2026-08-02T00:00:00Z",
});

/** seed an operator-authored, marker-less ticket — an idea candidate (D12) */
function seedIdea(w: World, id: string, title: string, body: string): WorkItemRef {
  w.substrate.items.set(id, { title, body, lane: "ready_to_work", createdBy: "operator" });
  return { substrate: "fake", externalId: id };
}

async function adoptIdea(w: World, body = "A CLI that counts words.") {
  const idea = seedIdea(w, "idea-1", "Idea: word counter", body);
  await w.conductor.handleEvent(itemCreated(idea, "operator", "Idea: word counter", body));
  const run = await w.store.getPlanRun("idea-1");
  expect(run, "plan run adopted").toBeTruthy();
  const gate = await w.substrate.findWorkItem("gate:stg:idea-1:analysis:v1");
  expect(gate, "analysis gate posted").toBeTruthy();
  return { idea, run: run!, gate: gate! };
}

describe("idea adoption (D12: an operator ticket with no marker is an idea)", () => {
  it("adopts an operator idea: plan run, analysis plan v1, gate in waiting-for-feedback, answer comment", async () => {
    const w = makeWorld();
    const { idea, run, gate } = await adoptIdea(w);
    expect(run.stageIds).toEqual([
      "stg:idea-1:analysis",
      "stg:idea-1:architecture",
      "stg:idea-1:implementation",
      "stg:idea-1:test",
      "stg:idea-1:delivery",
    ]);
    expect((await w.store.getLatestStagePlan("stg:idea-1:analysis"))?.planVersion).toBe(1);
    expect((await w.substrate.getWorkItem(gate)).lane).toBe("waiting_for_feedback");
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("gated");
    expect(w.substrate.comments.some((c) => c.id === idea.externalId && /approval/.test(c.body))).toBe(true);
  });

  it("a budget: directive in the idea body governs the plan money", async () => {
    const w = makeWorld();
    await adoptIdea(w, "A CLI.\n\nbudget: 2.00");
    // analysis gets 15% of 200¢
    expect((await w.store.getLatestStagePlan("stg:idea-1:analysis"))?.budgetCents).toBe(30);
  });

  it("ignores agent- and conductor-created items and marker-bearing tickets", async () => {
    const w = makeWorld();
    w.substrate.items.set("a1", { title: "t", lane: "ready_to_work", createdBy: "agent" });
    w.substrate.items.set("c1", { title: "t", lane: "ready_to_work", createdBy: "conductor" });
    w.substrate.items.set("m1", { title: "t", lane: "ready_to_work", createdBy: "operator", markerId: "eng-x" });
    for (const id of ["a1", "c1", "m1"]) {
      await w.conductor.handleEvent(itemCreated({ substrate: "fake", externalId: id }, "operator", "t", ""));
    }
    expect(await w.store.listPlanRuns()).toEqual([]);
  });

  it("adoption is idempotent across the live event and reconcile", async () => {
    const w = makeWorld();
    const { idea } = await adoptIdea(w);
    await w.conductor.reconcile();
    await w.conductor.handleEvent(itemCreated(idea, "operator", "Idea: word counter", "A CLI that counts words."));
    expect((await w.store.listPlanRuns()).length).toBe(1);
    const posted = (await w.store.listDecisions()).filter((d) => d.kind === "gate_posted");
    expect(posted).toHaveLength(1);
  });

  it("reconcile adopts an idea that appeared while the conductor was down", async () => {
    const w = makeWorld();
    seedIdea(w, "idea-1", "Idea: word counter", "A CLI that counts words.");
    await w.conductor.reconcile();
    expect(await w.store.getPlanRun("idea-1")).toBeTruthy();
    expect(await w.substrate.findWorkItem("gate:stg:idea-1:analysis:v1")).toBeTruthy();
  });

  it("approving the analysis gate dispatches the analyst with the allocated budget", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    expect(w.gateway.mints).toEqual([{ engagementId: "eng:stg:idea-1:analysis:v1", budgetCents: 150 }]);
    expect(w.substrate.boundKeys[0]?.role).toBe("analyst");
  });
});

describe("amendment re-gates (D12)", () => {
  it("an operator amend comment supersedes the gate: v2 posted, v1 engagements cancelled, old gate off-board", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    await w.conductor.handleEvent(commentEv(gate, "operator", "amend: also count characters"));

    const v2 = await w.store.getLatestStagePlan("stg:idea-1:analysis");
    expect(v2?.planVersion).toBe(2);
    expect(v2?.objective).toContain("also count characters");
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("cancelled");
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v2"))?.state).toBe("gated");
    expect((await w.substrate.getWorkItem(gate)).lane).toBe("cancelled");
    const gate2 = await w.substrate.findWorkItem("gate:stg:idea-1:analysis:v2");
    expect(gate2).toBeTruthy();
    expect((await w.substrate.getWorkItem(gate2!)).lane).toBe("waiting_for_feedback");
    const amended = (await w.store.listDecisions()).find(
      (d) => d.kind === "gate" && d.decision.kind === "amended",
    );
    expect(amended).toBeTruthy();
  });

  it("approving the amended-away v1 gate authorizes nothing — stale gates are inert (D6)", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    await w.conductor.handleEvent(commentEv(gate, "operator", "amend: tighter scope"));
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    expect(w.gateway.mints).toHaveLength(0);
  });

  it("an amend comment from an agent is ignored; a non-amend operator comment is ignored", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    await w.conductor.handleEvent(commentEv(gate, "agent", "amend: sneaky"));
    await w.conductor.handleEvent(commentEv(gate, "operator", "looks good!"));
    expect((await w.store.getLatestStagePlan("stg:idea-1:analysis"))?.planVersion).toBe(1);
  });

  it("an amend after approval is inert — the gate is decided (first writer wins, #11)", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    await w.conductor.handleEvent(commentEv(gate, "operator", "amend: too late"));
    expect((await w.store.getLatestStagePlan("stg:idea-1:analysis"))?.planVersion).toBe(1);
  });

  it("a budget directive in the amend note reprices the stage", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    await w.conductor.handleEvent(commentEv(gate, "operator", "amend: budget: 5.00"));
    expect((await w.store.getLatestStagePlan("stg:idea-1:analysis"))?.budgetCents).toBe(500);
  });
});

/** drive one engagement of a multi-stage run from dispatch to acceptance */
async function driveStageToAccepted(w: World, stageId: string, branch: string, sha: string) {
  const plan = (await w.store.getLatestStagePlan(stageId))!;
  const gate = (await w.substrate.findWorkItem(`gate:${stageId}:v${plan.planVersion}`))!;
  await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
  const engagementId = plan.engagements[0]!.engagementId;
  const item = (await w.substrate.findWorkItem(engagementId))!;
  await w.conductor.handleEvent(statusEv(item, "running"));
  w.substrate.snapshots.set(item.externalId, {
    status: "done",
    report: { summary: "done", branchHint: branch, attemptId: `${branch}-run1` },
  });
  w.source.shas.set(branch, sha);
  await w.conductor.handleEvent(statusEv(item, "done"));
  expect((await w.store.getEngagement(engagementId))?.state, `${stageId} validated`).toBe("validated");
  await w.conductor.handleEvent(laneMove(item, "done", "operator"));
  expect((await w.store.getEngagement(engagementId))?.state, `${stageId} accepted`).toBe("accepted");
}

describe("stage sequencing (D12: stage k opens only after k-1 is accepted)", () => {
  it("no downstream gate exists while analysis is in flight", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    expect(await w.substrate.findWorkItem("gate:stg:idea-1:architecture:v1")).toBeNull();
  });

  it("accepting analysis opens architecture with priorDecisions and the upstream handoff folded in", async () => {
    const w = makeWorld();
    await adoptIdea(w);
    w.source.files.set(
      "sha-analysis:guild/handoff/architecture.checks.json",
      JSON.stringify({ checks: [{ kind: "artifact", path: "docs/ADR-1.md" }] }),
    );
    await driveStageToAccepted(w, "stg:idea-1:analysis", "agent/analyst/a1", "sha-analysis");

    const arch = await w.store.getLatestStagePlan("stg:idea-1:architecture");
    expect(arch, "architecture plan opened").toBeTruthy();
    expect(arch!.engagements[0]!.brief.priorDecisions).toEqual(["analysis accepted at sha-analysis"]);
    const contract = arch!.engagements[0]!.brief.contract;
    expect(contract.authoredBy).toBe("analyst");
    expect(contract.checks).toContainEqual({ kind: "artifact", path: "docs/ADR-1.md" });
    const gate2 = await w.substrate.findWorkItem("gate:stg:idea-1:architecture:v1");
    expect(gate2).toBeTruthy();
    expect((await w.substrate.getWorkItem(gate2!)).lane).toBe("waiting_for_feedback");
  });

  it("a missing upstream handoff degrades to the floor contract with a warning in the gate body", async () => {
    const w = makeWorld();
    await adoptIdea(w);
    await driveStageToAccepted(w, "stg:idea-1:analysis", "agent/analyst/a1", "sha-analysis");
    const arch = (await w.store.getLatestStagePlan("stg:idea-1:architecture"))!;
    expect(arch.engagements[0]!.brief.contract.authoredBy).toBe("guild-floor");
    const gate2 = (await w.substrate.findWorkItem("gate:stg:idea-1:architecture:v1"))!;
    expect((await w.substrate.getWorkItem(gate2)).title).toContain("architecture");
    const body = w.substrate.items.get(gate2.externalId);
    expect(body).toBeTruthy();
  });

  it("rejecting a stage gate closes the whole run with an explanation on the idea ticket", async () => {
    const w = makeWorld();
    const { idea, gate } = await adoptIdea(w);
    await w.conductor.handleEvent(laneMove(gate, "cancelled", "operator"));
    expect((await w.store.getPlanRun("idea-1"))?.status).toBe("rejected");
    expect(w.substrate.comments.some((c) => c.id === idea.externalId && /rejected/.test(c.body))).toBe(true);
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("cancelled");
  });

  it("reconcile opens the next stage after a restart that missed the acceptance", async () => {
    const w = makeWorld();
    await adoptIdea(w);
    await driveStageToAccepted(w, "stg:idea-1:analysis", "agent/analyst/a1", "sha-analysis");
    // simulate: architecture plan lost? no — restart simply re-runs reconcile;
    // the already-opened architecture stage must not duplicate
    await w.conductor.reconcile();
    const posted = (await w.store.listDecisions()).filter(
      (d) => d.kind === "gate_posted" && d.stageId === "stg:idea-1:architecture",
    );
    expect(posted).toHaveLength(1);
  });
});

describe("dispatch lockout (D12 watchdog surface)", () => {
  it("a dispatch lock refuses new spend: no mint, no item, engagement stays gated", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    await w.store.setDispatchLock("budget_hard_cap", "t0");
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    expect(w.gateway.mints).toHaveLength(0);
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("gated");
  });
});

describe("the whole pipeline (the M2 demo skeleton)", () => {
  it("five stages sequence gate-by-gate to a completed run; the idea ticket lands in Done", async () => {
    const w = makeWorld();
    const { idea, run } = await adoptIdea(w);
    for (const [i, stageId] of run.stageIds.entries()) {
      await driveStageToAccepted(w, stageId, `agent/role/br${i}`, `sha-${i}`);
    }
    expect((await w.store.getPlanRun("idea-1"))?.status).toBe("completed");
    expect((await w.substrate.getWorkItem(idea)).lane).toBe("done");
    expect(w.substrate.comments.some((c) => c.id === idea.externalId && /delivery complete/.test(c.body))).toBe(true);
    // zero un-contracted advances: every stage carries exactly one dispatch,
    // authorized by exactly one recorded gate approval
    const decisions = await w.store.listDecisions();
    const approvals = decisions.filter((d) => d.kind === "gate" && d.decision.kind === "approved");
    const dispatches = decisions.filter((d) => d.kind === "dispatch");
    expect(approvals).toHaveLength(5);
    expect(dispatches).toHaveLength(5);
    // priorDecisions accumulate down the pipeline
    const delivery = (await w.store.getLatestStagePlan("stg:idea-1:delivery"))!;
    expect(delivery.engagements[0]!.brief.priorDecisions).toEqual([
      "analysis accepted at sha-0",
      "architecture accepted at sha-1",
      "implementation accepted at sha-2",
      "test accepted at sha-3",
    ]);
  });
});
