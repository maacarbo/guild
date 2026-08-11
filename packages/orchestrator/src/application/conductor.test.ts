import { describe, expect, it, vi } from "vitest";
import type {
  BoardActor,
  WorkItemComment,
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
  /** board-authored comments visible to the reconcile read path (#12) */
  seededComments: Array<{ id: string; commentId: string; author: string; actor: BoardActor; body: string; at: string }> = [];
  /** when true, listComments throws — a broken comments endpoint (#12 review) */
  failListComments = false;
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
  ticketBodies = new Map<string, string>();
  async createTicket(spec: TicketSpec): Promise<WorkItemRef> {
    this.ops.push("createTicket");
    const id = `ticket-${++this.seq}`;
    // faithful to Multica: a freshly created issue defaults to the `todo` status
    // = the ready_to_work go-lane (P24). postGate moves it to waiting_for_feedback
    // right after — the gap between is exactly the A5b crash window.
    this.items.set(id, { markerId: spec.markerId, title: spec.title, lane: "ready_to_work" });
    this.ticketBodies.set(id, spec.body);
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
  seedComment(item: WorkItemRef, actor: BoardActor, body: string, at: string): void {
    const commentId = `c-${this.seededComments.length + 1}`;
    this.seededComments.push({ id: item.externalId, commentId, author: actor, actor, body, at });
  }
  async listComments(item: WorkItemRef): Promise<WorkItemComment[]> {
    if (this.failListComments) throw new Error("comments endpoint 404");
    // board-authored first, then the conductor's own outbound comments —
    // reconcile filters by actor, so the conductor never reacts to itself
    return [
      ...this.seededComments
        .filter((c) => c.id === item.externalId)
        .map(({ commentId, author, actor, body, at }) => ({ commentId, author, actor, body, at, inReplyTo: null })),
      ...this.comments
        .filter((c) => c.id === item.externalId)
        .map((c, i) => ({
          commentId: `out-${i}`,
          author: "conductor",
          actor: "conductor" as BoardActor,
          body: c.body,
          at: `t-out-${i}`,
          inReplyTo: null,
        })),
    ];
  }
  async requestRework(item: WorkItemRef, verdict: ContractVerdict): Promise<void> {
    this.reworks.push({ id: item.externalId, verdict });
  }
  async cancel(item: WorkItemRef): Promise<void> {
    this.cancels.push(item.externalId);
  }
  async close(item: WorkItemRef, terminalLane: Lane = "done"): Promise<void> {
    this.closes.push(item.externalId);
    const it = this.items.get(item.externalId);
    if (it) it.lane = terminalLane;
  }
  // eslint-disable-next-line require-yield
  async *watch(): AsyncIterable<SubstrateEvent> {
    return;
  }
}

class FakeGateway implements ModelGateway {
  mints: Array<{ engagementId: string; budgetCents: number }> = [];
  revokes: string[] = [];
  /** scripted spend per engagement — the watchdog meters from here */
  spend = new Map<string, number>();
  /** keys the gateway no longer knows (revocation deletes them — live behavior) */
  deadKeys = new Set<string>();
  /** engagement ids whose spend read fails TRANSIENTLY (gateway 5xx) — distinct from absence (#12) */
  failSpendReads = new Set<string>();
  constructor(private readonly ops: OpLog) {}
  async mintKey(engagementId: string, budgetCents: number): Promise<EngagementKey> {
    this.ops.push("mintKey");
    this.mints.push({ engagementId, budgetCents });
    return { engagementId, key: `sk-${engagementId}`, budgetCents };
  }
  async revokeKey(engagementId: string): Promise<void> {
    this.revokes.push(engagementId);
  }
  async getSpend(engagementId: string): Promise<KeySpend | null> {
    if (this.failSpendReads.has(engagementId)) throw new Error(`gateway 503 for ${engagementId}`);
    if (this.deadKeys.has(engagementId)) return null; // definitive absence (port contract, #12)
    const budgetCents = this.mints.find((m) => m.engagementId === engagementId)?.budgetCents ?? 0;
    const spentCents = this.spend.get(engagementId) ?? 0;
    return { engagementId, spentCents, budgetCents, exhausted: budgetCents > 0 && spentCents >= budgetCents };
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

function makeWorld(configOver: Partial<ConstructorParameters<typeof Conductor>[1]> = {}) {
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
      ...configOver,
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
    // cancelled work must NOT show as accepted on the board (D11; #17 B9)
    expect((await w.substrate.getWorkItem(item)).lane).toBe("cancelled");
  });

  it("a validated engagement accepted by the operator closes in the Done lane (B9 does not mislabel acceptance)", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w);
    await w.conductor.handleEvent(laneMove(item, "done", "operator"));
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("accepted");
    expect((await w.substrate.getWorkItem(item)).lane).toBe("done");
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

describe("template: directive shapes the plan run (M3, D12 amendment)", () => {
  it("a quick-fix idea adopts as a two-stage run: implementation → test", async () => {
    const w = makeWorld();
    const idea = seedIdea(w, "idea-qf", "Idea: tiny fix", "Fix the typo.\ntemplate: quick-fix");
    await w.conductor.handleEvent(itemCreated(idea, "operator", "Idea: tiny fix", "Fix the typo.\ntemplate: quick-fix"));
    const run = await w.store.getPlanRun("idea-qf");
    expect(run?.stageIds).toEqual(["stg:idea-qf:implementation", "stg:idea-qf:test"]);
    expect(await w.substrate.findWorkItem("gate:stg:idea-qf:implementation:v1"), "first gate is implementation").toBeTruthy();
  });
});

describe("amend-while-down recovery (#12: reconcile consults gate comments)", () => {
  it("an operator amend comment posted while the conductor was down is applied on reconcile", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    // downtime: the comment landed on the board only — no event ever arrived
    w.substrate.seedComment(gate, "operator", "amend: also count characters", "t-amend");

    await w.conductor.reconcile();
    expect(await w.substrate.findWorkItem("gate:stg:idea-1:analysis:v2"), "re-gated at v2").toBeTruthy();
    const latest = await w.store.getLatestStagePlan("stg:idea-1:analysis");
    expect(latest?.planVersion).toBe(2);
    expect(latest?.objective).toContain("also count characters");
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("cancelled");
    // idempotent: a second pass must not re-apply the same note
    await w.conductor.reconcile();
    expect((await w.store.getLatestStagePlan("stg:idea-1:analysis"))?.planVersion).toBe(2);
  });

  it("amend WINS over a downtime go-lane: re-gate, never dispatch the pre-amend plan", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    w.substrate.items.get(gate.externalId)!.lane = "ready_to_work"; // moved while down
    w.substrate.seedComment(gate, "operator", "amend: tighter scope", "t-amend");

    await w.conductor.reconcile();
    expect(await w.substrate.findWorkItem("gate:stg:idea-1:analysis:v2"), "amended, not dispatched").toBeTruthy();
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("cancelled");
    expect(w.gateway.mints, "no key minted from the stale move").toHaveLength(0);
  });

  it("a crash after the amended decision but before the re-gate is repaired on reconcile", async () => {
    const w = makeWorld();
    await adoptIdea(w);
    // crash simulation: the amended decision committed, the tail never ran —
    // first-writer-wins would block every comment replay forever
    await w.store.recordGateDecision({
      kind: "amended",
      stageId: "stg:idea-1:analysis",
      planVersion: 1,
      note: "amend: crashed midway",
      at: "t-crash",
    });

    await w.conductor.reconcile();
    expect(await w.substrate.findWorkItem("gate:stg:idea-1:analysis:v2"), "tail re-driven").toBeTruthy();
    expect((await w.store.getLatestStagePlan("stg:idea-1:analysis"))?.planVersion).toBe(2);
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("cancelled");
  });

  it("a broken comments endpoint still neutralizes a downtime go-lane (D15c holds)", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    w.substrate.items.get(gate.externalId)!.lane = "ready_to_work";
    w.substrate.failListComments = true;

    // the scan failure surfaces in reconcile's error aggregate — but must not
    // have skipped the neutralization
    await w.conductor.reconcile().catch(() => {});
    expect((await w.substrate.getWorkItem(gate)).lane).toBe("waiting_for_feedback");
  });

  it("a non-operator amend comment recovers nothing — attribution fails closed", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    w.substrate.seedComment(gate, "agent", "amend: malicious repricing budget: 99.00", "t-x");

    await w.conductor.reconcile();
    expect(await w.substrate.findWorkItem("gate:stg:idea-1:analysis:v2")).toBeNull();
    expect((await w.store.getLatestStagePlan("stg:idea-1:analysis"))?.planVersion).toBe(1);
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

  it("re-asserts a gate go-lane found on reconcile — never approves on lane alone (D15 A5c)", async () => {
    const w = makeWorld();
    const gate = await post(w);
    // a go-lane observed on reconcile carries no actor (the snapshot has none), so
    // it could be the operator OR an agent/forged move — reconcile cannot tell.
    // Approval spends, so it must come only from the live operator-attributed event.
    await w.substrate.setLane(gate, "ready_to_work");
    await w.conductor.reconcile();
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("gated"); // NOT dispatched — no spend
    expect(w.gateway.mints).toHaveLength(0);
    expect((await w.store.listDecisions()).filter((d) => d.kind === "gate")).toHaveLength(0);
    // the pending gate is re-surfaced in its resting lane so the operator re-moves it
    expect((await w.substrate.getWorkItem(gate)).lane).toBe("waiting_for_feedback");
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

  it("re-asserts a validated engagement's done lane — never accepts on lane alone (D15 A5c)", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w);
    // acceptance fast-forwards the validated SHA; like approval it must come only
    // from the live operator move, never from an unattributed done lane on reconcile
    await w.substrate.setLane(item, "done");
    await w.conductor.reconcile();
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("validated"); // NOT accepted
    expect(w.source.ffs).toEqual([]); // no fast-forward
    // re-surfaced in its resting lane — one operator gesture to accept
    expect((await w.substrate.getWorkItem(item)).lane).toBe("waiting_for_feedback");
  });

  it("isolates a permanently-throwing item so later engagements still reconcile (B2)", async () => {
    const w = makeWorld();
    // eng-1: validated, its ticket sits in Done; re-asserting its resting lane
    // (D15 conservative reconcile) hits a substrate fault — reconcile must isolate it
    w.substrate.items.set("i1", { markerId: "eng-1", title: "one", lane: "done", createdBy: "conductor" });
    await w.store.saveEngagement({
      engagementId: "eng-1",
      stageId: "s",
      planVersion: 1,
      state: "validated",
      bounceCount: 0,
      item: { substrate: "fake", externalId: "i1" },
      validatedSha: "sha-bad",
    });
    const realSetLane = w.substrate.setLane.bind(w.substrate);
    w.substrate.setLane = async (ref: WorkItemRef, lane: Lane) => {
      if (ref.externalId === "i1") throw new Error("substrate rejected the lane re-assert");
      return realSetLane(ref, lane);
    };
    // eng-2: dispatched, its task started while down — must still advance
    w.substrate.items.set("i2", { markerId: "eng-2", title: "two", lane: "ready_to_work", createdBy: "conductor" });
    w.substrate.snapshots.set("i2", { status: "running" });
    await w.store.saveEngagement({
      engagementId: "eng-2",
      stageId: "s",
      planVersion: 1,
      state: "dispatched",
      bounceCount: 0,
      item: { substrate: "fake", externalId: "i2" },
    });

    // reconcile surfaces an aggregate error (visibility preserved) but only AFTER
    // attempting every item — swallow it here to inspect the per-item outcomes
    await w.conductor.reconcile().catch(() => {});

    expect((await w.store.getEngagement("eng-1"))?.state, "the failing accept left eng-1 untouched").toBe("validated");
    expect((await w.store.getEngagement("eng-2"))?.state, "eng-2 reconciled despite eng-1 throwing").toBe("working");
  });

  it("warns when a non-attributed member move on a governance ticket is dropped (D15 deadlock visibility)", async () => {
    const w = makeWorld();
    const gate = await post(w);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // a member not on the operator allowlist maps to "unknown" — the signature of a
    // stale/empty GUILD_OPERATOR_MEMBER_IDS silently dropping a real operator move
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "unknown"));
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("gated"); // dropped, not approved
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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

async function adoptIdea(w: World, body = "A CLI that counts words.", id = "idea-1") {
  const idea = seedIdea(w, id, "Idea: word counter", body);
  await w.conductor.handleEvent(itemCreated(idea, "operator", "Idea: word counter", body));
  const run = await w.store.getPlanRun(id);
  expect(run, "plan run adopted").toBeTruthy();
  const gate = await w.substrate.findWorkItem(`gate:stg:${id}:analysis:v1`);
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

describe("reconcile attribution (A5: unattributed board state must not self-approve)", () => {
  it("does not read a crash-created gate ticket's go-lane default as an operator approval (A5b)", async () => {
    const w = makeWorld();
    // crash the initial resting-lane set: the gate ticket is created (landing in
    // the ready_to_work go-lane default) but never moved to waiting_for_feedback,
    // and no gate_posted decision is recorded
    const realSetLane = w.substrate.setLane.bind(w.substrate);
    let crashed = false;
    w.substrate.setLane = async (item, lane) => {
      if (!crashed) {
        crashed = true;
        throw new Error("crash after createTicket, before the gate's resting-lane set");
      }
      return realSetLane(item, lane);
    };
    const idea = seedIdea(w, "idea-1", "Idea", "A CLI that counts words.");
    await w.conductor.handleEvent(itemCreated(idea, "operator", "Idea", "A CLI that counts words.")).catch(() => {});
    w.substrate.setLane = realSetLane;
    const gate = (await w.substrate.findWorkItem("gate:stg:idea-1:analysis:v1"))!;
    expect((await w.substrate.getWorkItem(gate)).lane, "the crashed gate sits in the go-lane").toBe("ready_to_work");

    await w.conductor.reconcile();

    expect(w.gateway.mints, "a crash-created gate must never be read as an approval").toHaveLength(0);
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("gated");
    expect((await w.substrate.getWorkItem(gate)).lane, "reconcile re-asserts the resting lane").toBe(
      "waiting_for_feedback",
    );
  });

  it("honors an operator reject made during the gate crash window — does not clobber it (A5b)", async () => {
    const w = makeWorld();
    const realSetLane = w.substrate.setLane.bind(w.substrate);
    let crashed = false;
    w.substrate.setLane = async (item, lane) => {
      if (!crashed) {
        crashed = true;
        throw new Error("crash after createTicket, before the gate's resting-lane set");
      }
      return realSetLane(item, lane);
    };
    const idea = seedIdea(w, "idea-1", "Idea", "A CLI that counts words.");
    await w.conductor.handleEvent(itemCreated(idea, "operator", "Idea", "A CLI that counts words.")).catch(() => {});
    w.substrate.setLane = realSetLane;
    const gate = (await w.substrate.findWorkItem("gate:stg:idea-1:analysis:v1"))!;
    // the operator sees the crashed gate and rejects it (off-board) during the window
    await w.substrate.setLane(gate, "cancelled");

    await w.conductor.reconcile();

    // the reject is honored, not overwritten back to waiting_for_feedback
    expect((await w.store.getPlanRun("idea-1"))?.status).toBe("rejected");
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("cancelled");
    expect(w.gateway.mints).toHaveLength(0);
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

// ------------------------------- M2b: budget watchdog + terminal recovery

describe("budget watchdog (D12: warn at the soft cap, halt at the project hard cap)", () => {
  it("warns ONCE per engagement at the soft cap: comment + budget decision, deduped across sweeps", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w); // eng-1, budget 500¢, soft cap 400¢
    w.gateway.spend.set("eng-1", 420);
    await w.conductor.sweep();
    await w.conductor.sweep();
    const warns = w.substrate.comments.filter((c) => c.id === item.externalId && /soft/i.test(c.body));
    expect(warns).toHaveLength(1);
    const budget = (await w.store.listDecisions()).filter((d) => d.kind === "budget");
    expect(budget).toHaveLength(1);
    expect(budget[0]).toMatchObject({
      event: { kind: "soft_cap", scope: "engagement", engagementId: "eng-1", spentCents: 420, capCents: 400 },
    });
  });

  it("below the soft cap nothing happens", async () => {
    const w = makeWorld();
    await postAndApprove(w);
    w.gateway.spend.set("eng-1", 100);
    await w.conductor.sweep();
    expect((await w.store.listDecisions()).filter((d) => d.kind === "budget")).toHaveLength(0);
  });

  it("the project hard cap cancels in-flight work, locks dispatch, and explains itself — once", async () => {
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 600, hardCapCents: 800 } });
    const { idea, gate } = await adoptIdea(w);
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    const item = (await w.substrate.findWorkItem("eng:stg:idea-1:analysis:v1"))!;
    await w.conductor.handleEvent(statusEv(item, "running"));
    w.gateway.spend.set("eng:stg:idea-1:analysis:v1", 900);
    await w.conductor.sweep();
    await w.conductor.sweep();

    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("cancelled");
    expect(w.substrate.cancels).toContain(item.externalId);
    expect(w.gateway.revokes).toContain("eng:stg:idea-1:analysis:v1");
    expect(await w.store.getDispatchLock()).toBeTruthy();
    const hard = (await w.store.listDecisions()).filter(
      (d) => d.kind === "budget" && d.event.kind === "hard_cap",
    );
    expect(hard).toHaveLength(1);
    expect(hard[0]).toMatchObject({
      event: { scope: "project", spentCents: 900, capCents: 800, cancelled: ["eng:stg:idea-1:analysis:v1"] },
    });
    expect(w.substrate.comments.some((c) => c.id === idea.externalId && /hard cap/i.test(c.body))).toBe(true);
  });

  it("the project soft cap warns on the idea ticket without cancelling anything", async () => {
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 600, hardCapCents: 5000 } });
    const { idea, gate } = await adoptIdea(w);
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    w.gateway.spend.set("eng:stg:idea-1:analysis:v1", 700);
    await w.conductor.sweep();
    await w.conductor.sweep();
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("dispatched");
    const softs = (await w.store.listDecisions()).filter(
      (d) => d.kind === "budget" && d.event.kind === "soft_cap" && d.event.scope === "project",
    );
    expect(softs).toHaveLength(1);
    expect(w.substrate.comments.some((c) => c.id === idea.externalId && /soft/i.test(c.body))).toBe(true);
  });

  it("a validated engagement survives the hard cap — done work awaiting acceptance is not destroyed", async () => {
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 600, hardCapCents: 800 } });
    const { item } = await driveToReported(w); // eng-1 validated
    w.gateway.spend.set("eng-1", 900);
    await w.conductor.sweep();
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("validated");
    expect(w.substrate.cancels).not.toContain(item.externalId);
    expect(await w.store.getDispatchLock()).toBeTruthy();
  });

  it("a raised hard cap releases the lock at the next sweep with a trail entry (the only exit — D12)", async () => {
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 6000, hardCapCents: 9000 } });
    await postAndApprove(w);
    // the lock was set at the moment the cap it breached was 800; the running
    // config now carries the raised cap (9000) — that raise is what releases it
    await w.store.setDispatchLock("budget_hard_cap: spend 900 >= cap 800", "t0", 800);
    w.gateway.spend.set("eng-1", 900);
    await w.conductor.sweep();
    expect(await w.store.getDispatchLock()).toBeNull();
    const released = (await w.store.listDecisions()).find(
      (d) => d.kind === "budget" && d.event.kind === "lock_released",
    );
    expect(released).toMatchObject({ event: { spentCents: 900, capCents: 9000 } });
  });

  it("does NOT release a budget lock while the cap is unchanged, even as spend sits below it (A1)", async () => {
    // the budget lock records the cap it breached; a sweep at spend-below-cap
    // must not clear it — only a genuine raise-and-restart does
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 600, hardCapCents: 800 } });
    await postAndApprove(w);
    await w.store.setDispatchLock("budget_hard_cap: spend 810 >= cap 800", "t0", 800);
    w.gateway.spend.set("eng-1", 100); // a revoked/terminated reading dropped it below the cap
    await w.conductor.sweep();
    expect(await w.store.getDispatchLock(), "lock stays until the cap is raised").toBeTruthy();
  });
});

describe("terminal-effect recovery (#11: a crash between the terminal transition and its effects)", () => {
  it("reconcile re-drives acceptance effects: revoke, close, termination entry — exactly once", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w);
    // crash simulation: the terminal transition persisted, effects never ran
    const rec = (await w.store.getEngagement("eng-1"))!;
    await w.store.saveEngagement({ ...rec, state: "accepted" });
    expect(w.gateway.revokes).toHaveLength(0);

    await w.conductor.reconcile();
    expect(w.gateway.revokes).toContain("eng-1");
    expect(w.substrate.closes).toContain(item.externalId);
    const terms = (await w.store.listDecisions()).filter(
      (d) => d.kind === "termination" && d.terminated.engagementId === "eng-1",
    );
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ terminated: { finalState: "accepted" } });
    await w.conductor.reconcile();
    expect(
      (await w.store.listDecisions()).filter((d) => d.kind === "termination" && d.terminated.engagementId === "eng-1"),
    ).toHaveLength(1);
  });

  it("reconcile re-drives a cancelled engagement's effects with the recovered reason", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w);
    const rec = (await w.store.getEngagement("eng-1"))!;
    // crash after the transition write of an operator cancellation
    await w.store.saveEngagement({ ...rec, state: "cancelled" });
    await w.store.appendDecision({
      kind: "transition",
      engagementId: "eng-1",
      from: "dispatched",
      to: "cancelled",
      cause: "cancelled: operator",
      at: "t0",
    });
    await w.conductor.reconcile();
    expect(w.gateway.revokes).toContain("eng-1");
    expect(w.substrate.cancels).toContain(item.externalId);
    const term = (await w.store.listDecisions()).find((d) => d.kind === "termination");
    expect(term).toMatchObject({ terminated: { finalState: "cancelled", reason: "operator" } });
  });

  it("reconcile re-drives an escalated engagement's key revocation and trail entry", async () => {
    const w = makeWorld();
    await postAndApprove(w);
    const rec = (await w.store.getEngagement("eng-1"))!;
    await w.store.saveEngagement({ ...rec, state: "escalated" });
    await w.conductor.reconcile();
    expect(w.gateway.revokes).toContain("eng-1");
    const term = (await w.store.listDecisions()).find((d) => d.kind === "termination");
    expect(term).toMatchObject({ terminated: { finalState: "escalated", reason: "bounce_limit" } });
  });
});

describe("hollow rework detection (#11: a new attempt whose head never moved is judged, not stranded)", () => {
  it("reconcile bounces a second hollow completion via the attempt signal and escalates the third", async () => {
    const w = makeWorld();
    // attempt 1: hollow (branch never pushed) → bounce 1
    await driveToReported(w, { report: { summary: "ack", branchHint: "agent/worker/h1", attemptId: "run-1" } });
    w.source.shas.delete("agent/worker/abc12345");
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("bounced");
    expect((await w.store.getEngagement("eng-1"))?.bounceCount).toBe(1);

    // attempt 2: rework reports done, still nothing pushed — only the attempt id moved
    const item = (await w.substrate.findWorkItem("eng-1"))!;
    w.substrate.snapshots.set(item.externalId, {
      status: "done",
      report: { summary: "done again", branchHint: "agent/worker/h2", attemptId: "run-2" },
    });
    await w.conductor.reconcile();
    expect((await w.store.getEngagement("eng-1"))?.bounceCount).toBe(2);
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("bounced");

    // attempt 3: hollow again → past MAX_BOUNCES → escalated
    w.substrate.snapshots.set(item.externalId, {
      status: "done",
      report: { summary: "totally done", branchHint: "agent/worker/h3", attemptId: "run-3" },
    });
    await w.conductor.reconcile();
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("escalated");

    // and a settled escalation stays settled
    await w.conductor.reconcile();
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("escalated");
  });
});

describe("project accounting survives key revocation (termination captures the final spend)", () => {
  it("acceptance records the engagement's final spend in its termination entry", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w);
    w.gateway.spend.set("eng-1", 42);
    await w.conductor.handleEvent(laneMove(item, "done", "operator"));
    const term = (await w.store.listDecisions()).find((d) => d.kind === "termination");
    expect(term).toMatchObject({ terminated: { finalState: "accepted", spentCents: 42 } });
  });

  it("project-cap notices reach EVERY active run's idea ticket, not an arbitrary first (#12)", async () => {
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 800, hardCapCents: 900 } });
    const a = await adoptIdea(w);
    const b = await adoptIdea(w, "A second concurrent idea.", "idea-2");
    await w.conductor.handleEvent(laneMove(a.gate, "ready_to_work", "operator"));
    await w.conductor.handleEvent(laneMove(b.gate, "ready_to_work", "operator"));
    w.gateway.spend.set("eng:stg:idea-1:analysis:v1", 500);
    w.gateway.spend.set("eng:stg:idea-2:analysis:v1", 500);

    await w.conductor.sweep(); // 1000 >= 900 → hard cap halts the project
    const noticed = w.substrate.comments.filter((c) => /hard cap/i.test(c.body)).map((c) => c.id);
    expect(noticed.sort()).toEqual(["idea-1", "idea-2"]);
  });

  it("acceptance persists the final spend on the record BEFORE revoking the key (#12)", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w);
    w.gateway.spend.set("eng-1", 42);
    await w.conductor.handleEvent(laneMove(item, "done", "operator"));
    expect((await w.store.getEngagement("eng-1"))?.terminalSpendCents).toBe(42);
  });

  it("a crash between revocation and the termination entry cannot lose the spend: the re-drive reads the persisted reading (#12)", async () => {
    const w = makeWorld();
    await driveToReported(w);
    // crash simulation: transition + spend reading persisted, key revoked,
    // then death before the termination entry was appended
    const rec = (await w.store.getEngagement("eng-1"))!;
    await w.store.saveEngagement({ ...rec, state: "accepted", terminalSpendCents: 30 });
    w.gateway.deadKeys.add("eng-1");

    await w.conductor.reconcile();
    const term = (await w.store.listDecisions()).find(
      (d) => d.kind === "termination" && d.terminated.engagementId === "eng-1",
    );
    expect(term).toMatchObject({ terminated: { finalState: "accepted", spentCents: 30 } });
  });

  it("a TRANSIENT spend-read failure aborts termination before revocation — the key survives for the re-drive (#12)", async () => {
    const w = makeWorld();
    const { item } = await driveToReported(w);
    w.gateway.spend.set("eng-1", 42);
    w.gateway.failSpendReads.add("eng-1");

    await expect(w.conductor.handleEvent(laneMove(item, "done", "operator"))).rejects.toThrow();
    expect(w.gateway.revokes, "no revocation on a failed read").toHaveLength(0);
    expect(
      (await w.store.listDecisions()).some((d) => d.kind === "termination"),
      "no spendless termination entry",
    ).toBe(false);

    // gateway recovers; the re-drive reads the still-live key
    w.gateway.failSpendReads.clear();
    await w.conductor.reconcile();
    const term = (await w.store.listDecisions()).find(
      (d) => d.kind === "termination" && d.terminated.engagementId === "eng-1",
    );
    expect(term).toMatchObject({ terminated: { finalState: "accepted", spentCents: 42 } });
    expect(w.gateway.revokes).toContain("eng-1");
  });

  it("the sweep counts a persisted terminal spend whose termination entry has not landed yet (#12)", async () => {
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 1, hardCapCents: 40 } });
    const { item } = await driveToReported(w);
    w.gateway.spend.set("eng-1", 30);
    await w.conductor.handleEvent(laneMove(item, "done", "operator"));
    // simulate the revoke→entry window: spend persisted on the record, key
    // dead, but strip the termination entry the accept appended
    w.gateway.deadKeys.add("eng-1");
    const withoutTermination = (await w.store.listDecisions()).filter((d) => d.kind !== "termination");
    (w.store as unknown as { decisions: unknown[] }).decisions = withoutTermination;

    const { gate } = await adoptIdea(w, "A second concurrent idea.", "idea-2");
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    w.gateway.spend.set("eng:stg:idea-2:analysis:v1", 15);

    await w.conductor.sweep(); // 30 (persisted terminal) + 15 (live) = 45 >= 40
    expect(await w.store.getDispatchLock(), "hard cap tripped from the persisted reading").toBeTruthy();
  });

  it("the sweep totals live keys PLUS terminated recordings — a revoked key never crashes it", async () => {
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 1, hardCapCents: 40 } });
    // engagement 1: full lifecycle, 30¢ spent, key revoked at acceptance
    const { item } = await driveToReported(w);
    w.gateway.spend.set("eng-1", 30);
    await w.conductor.handleEvent(laneMove(item, "done", "operator"));
    w.gateway.deadKeys.add("eng-1"); // the gateway now throws for it
    // engagement 2: a second idea's analysis in flight with 15¢ live spend
    const { gate } = await adoptIdea(w);
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    w.gateway.spend.set("eng:stg:idea-1:analysis:v1", 15);

    await w.conductor.sweep(); // 30 (terminated) + 15 (live) = 45 >= 40 → halt
    expect(await w.store.getDispatchLock()).toBeTruthy();
    const hard = (await w.store.listDecisions()).find((d) => d.kind === "budget" && d.event.kind === "hard_cap");
    expect(hard).toMatchObject({ event: { spentCents: 45, capCents: 40 } });
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("cancelled");
  });
});

describe("gate decisions are exclusive — losers of the race act on what actually stuck (M2b verify)", () => {
  it("a late reject against an approved gate is inert: the run stays active, work continues", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    expect(w.gateway.mints).toHaveLength(1);
    // weeks later: the Done gate ticket gets dragged off-board during cleanup
    await w.conductor.handleEvent(laneMove(gate, "cancelled", "operator"));
    expect((await w.store.getPlanRun("idea-1"))?.status).toBe("active");
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("dispatched");
    expect(w.substrate.comments.filter((c) => /rejected/.test(c.body))).toHaveLength(0);
  });

  it("a late approve against a rejected gate dispatches nothing and leaves the gate off-board", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    await w.conductor.handleEvent(laneMove(gate, "cancelled", "operator"));
    expect((await w.store.getPlanRun("idea-1"))?.status).toBe("rejected");
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    expect(w.gateway.mints).toHaveLength(0);
    expect((await w.substrate.getWorkItem(gate)).lane).not.toBe("done");
  });

  it("an approve re-drive after a crash mid-dispatch still resumes: the recorded decision IS an approval", async () => {
    const w = makeWorld();
    const { gate } = await adoptIdea(w);
    // crash simulation: the decision landed but no dispatch effect ran
    await w.store.recordGateDecision({
      kind: "approved",
      stageId: "stg:idea-1:analysis",
      planVersion: 1,
      by: "operator",
      at: "t0",
    });
    await w.conductor.handleEvent(laneMove(gate, "ready_to_work", "operator"));
    expect(w.gateway.mints).toHaveLength(1);
    expect((await w.store.getEngagement("eng:stg:idea-1:analysis:v1"))?.state).toBe("dispatched");
  });
});

describe("emergency stop (guild kill — D11 scope)", () => {
  it("locks dispatch FIRST, then cancels every spending engagement", async () => {
    const w = makeWorld();
    const { item } = await postAndApprove(w);
    await w.conductor.handleEvent(statusEv(item, "running"));
    await w.conductor.emergencyStop();
    expect((await w.store.getDispatchLock())?.reason).toMatch(/kill/);
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("cancelled");
    expect(w.substrate.cancels).toContain(item.externalId);
    expect(w.gateway.revokes).toContain("eng-1");
  });

  it("locks even when nothing was ever dispatched, and is idempotent", async () => {
    const w = makeWorld();
    await w.conductor.emergencyStop();
    expect(await w.store.getDispatchLock()).toBeTruthy();
    await w.conductor.emergencyStop();
    expect(await w.store.getDispatchLock()).toBeTruthy();
  });

  it("the kill lock is NOT auto-released by a budget sweep when spend is below the cap (A1)", async () => {
    // the core-promise regression: `guild kill` fires while spend is below the
    // hard cap (the normal case), so a sweep that releases on spend<cap would
    // clear the kill lock on its very next tick and let a later approval dispatch
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 600, hardCapCents: 800 } });
    const { item } = await postAndApprove(w); // eng-1 dispatched → a minted intent exists so the sweep runs
    await w.conductor.handleEvent(statusEv(item, "running"));
    w.gateway.spend.set("eng-1", 100); // well below the 800 hard cap
    await w.conductor.emergencyStop();
    await w.conductor.sweep();
    await w.conductor.sweep();
    const lock = await w.store.getDispatchLock();
    expect(lock, "the kill switch must stay engaged across sweeps").toBeTruthy();
    expect(lock?.reason).toMatch(/kill/);
    expect((await w.store.getEngagement("eng-1"))?.state).toBe("cancelled");
  });

  it("anchors the kill lock to the conductor's PERSISTED enforced cap, not a divergent caller env (A1)", async () => {
    // guild-kill runs as a separate process reading a possibly-edited .env; it
    // must stamp the lock with the cap the running conductor actually enforces
    // (persisted at that conductor's startup), or a lowered-then-killed sequence
    // self-releases the lock. Here config carries a DIFFERENT (stale) value than
    // the persisted enforced cap — the enforced cap must win.
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 600, hardCapCents: 999 } });
    await w.store.setEnforcedHardCap(10000);
    await w.conductor.emergencyStop();
    expect((await w.store.getDispatchLock())?.capCents).toBe(10000);
  });

  it("a kill lock releases only after the operator raises the hard cap and restarts (A1 recovery)", async () => {
    const w = makeWorld({ projectBudget: { projectId: "ws-1", softCapCents: 600, hardCapCents: 800 } });
    const { item } = await postAndApprove(w);
    await w.conductor.handleEvent(statusEv(item, "running"));
    w.gateway.spend.set("eng-1", 100);
    await w.conductor.emergencyStop();
    expect(await w.store.getDispatchLock()).toBeTruthy();
    // operator raises GUILD_PROJECT_HARD_CAP_CENTS and restarts — same store, new cap
    const restarted = new Conductor(
      { substrate: w.substrate, gateway: w.gateway, validator: w.validator, source: w.source, store: w.store, now: () => "2026-08-02T00:00:00Z" },
      {
        projectScope: "ws-1",
        repoUrl: "git@example.com:owner/product.git",
        targetBranch: "main",
        defaultPlanBudgetCents: 1000,
        projectBudget: { projectId: "ws-1", softCapCents: 600, hardCapCents: 5000 },
      },
    );
    await restarted.sweep();
    expect(await w.store.getDispatchLock(), "a genuine cap raise clears the kill lock").toBeNull();
  });
});

describe("the gate body renders the WHOLE contract (D12: approval covers content)", () => {
  it("upstream-authored gherkin appears in the gate ticket body, not just the checks", async () => {
    const w = makeWorld();
    await adoptIdea(w);
    w.source.files.set(
      "sha-a:guild/handoff/architecture.checks.json",
      JSON.stringify({
        gherkin: "Feature: sneaky upstream criteria",
        checks: [{ kind: "artifact", path: "docs/UPSTREAM.md" }],
      }),
    );
    await driveStageToAccepted(w, "stg:idea-1:analysis", "agent/analyst/a1", "sha-a");
    const gate2 = (await w.substrate.findWorkItem("gate:stg:idea-1:architecture:v1"))!;
    const stored = w.substrate.items.get(gate2.externalId);
    expect(stored).toBeTruthy();
    // the fake keeps only title; assert via the createTicket capture instead
    const body = w.substrate.ticketBodies.get(gate2.externalId) ?? "";
    expect(body).toContain("sneaky upstream criteria");
  });

  it("a zero-check handoff degrades visibly — the gate body warns and stays floor-authored (C5)", async () => {
    const w = makeWorld();
    await adoptIdea(w);
    w.source.files.set(
      "sha-a:guild/handoff/architecture.checks.json",
      JSON.stringify({ gherkin: "Feature: sneaky upstream criteria", checks: [] }),
    );
    await driveStageToAccepted(w, "stg:idea-1:analysis", "agent/analyst/a1", "sha-a");
    const gate2 = (await w.substrate.findWorkItem("gate:stg:idea-1:architecture:v1"))!;
    const body = w.substrate.ticketBodies.get(gate2.externalId) ?? "";
    expect(body).toContain("No valid upstream handoff");
    expect(body).toContain("authored by guild-floor");
    expect(body).not.toContain("sneaky upstream criteria");
  });
});
