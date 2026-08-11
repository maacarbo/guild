import { describe, expect, it } from "vitest";
import type { ContractVerdict, EngagementBrief, WorkItemSpec } from "@guild/shared";
import { isSubstrateError } from "@guild/shared";
import type { MulticaAgent, MulticaComment, MulticaIssue, MulticaTaskRun } from "../domain/multica-types.js";
import type { MulticaApi, MulticaWsFrame } from "../ports/multica-api.js";
import { MulticaHttpError } from "../ports/multica-api.js";
import { MulticaSubstrate } from "./multica-substrate.js";

const brief: EngagementBrief = {
  roleContext: "role",
  instructions: "do it",
  contract: {
    contractId: "c1",
    version: 1,
    authoredBy: "analyst",
    gherkin: "Feature: x",
    checks: [],
  },
  priorDecisions: [],
  artifactRefs: [],
  constraints: [],
};

const spec = (engagementId: string, role = "worker"): WorkItemSpec => ({
  engagementId,
  role,
  title: `work for ${engagementId}`,
  brief,
});

class FakeMulticaApi implements MulticaApi {
  issues = new Map<string, MulticaIssue>();
  runs = new Map<string, MulticaTaskRun[]>();
  comments: Array<MulticaComment & { issue_id: string }> = [];
  cancelled: string[] = [];
  agents: MulticaAgent[] = [
    { id: "agent-1", name: "worker-agent", model: "litellm/or-gemini-flash-lite", runtime_id: "rt-1" },
  ];
  archivedAgents: MulticaAgent[] = [];
  private seq = 0;

  async createIssue(input: { title: string; description: string }): Promise<MulticaIssue> {
    const issue: MulticaIssue = {
      id: `issue-${++this.seq}`,
      title: input.title,
      description: input.description,
      status: "todo",
      assignee_id: null,
      // real Multica attributes the creator from the auth token — this fake is
      // authed as the conductor member, so its own creations carry that id
      creator_type: "member",
      creator_id: "member-self",
      updated_at: "2026-07-31T12:00:00Z",
    };
    this.issues.set(issue.id, issue);
    return issue;
  }
  async getIssue(id: string): Promise<MulticaIssue> {
    const issue = this.issues.get(id);
    if (!issue) throw new MulticaHttpError(404, `no issue ${id}`);
    return issue;
  }
  async listIssues(): Promise<MulticaIssue[]> {
    return [...this.issues.values()];
  }
  async updateIssue(id: string, patch: Partial<MulticaIssue>): Promise<MulticaIssue> {
    const issue = await this.getIssue(id);
    Object.assign(issue, patch);
    return issue;
  }
  async listTaskRuns(issueId: string): Promise<MulticaTaskRun[]> {
    return this.runs.get(issueId) ?? [];
  }
  async createComment(issueId: string, content: string, parentId?: string): Promise<MulticaComment> {
    const c: MulticaComment = {
      id: `comment-${++this.seq}`,
      issue_id: issueId,
      content,
      parent_id: parentId ?? null,
      author_type: "member",
      created_at: "2026-07-31T12:00:00Z",
    };
    this.comments.push(c);
    return c;
  }
  async listAgents(opts?: { includeArchived?: boolean }): Promise<MulticaAgent[]> {
    return opts?.includeArchived ? [...this.agents, ...this.archivedAgents] : [...this.agents];
  }
  runtimes: Array<{ id: string; status: string }> = [{ id: "rt-1", status: "online" }];
  async listRuntimes() {
    return this.runtimes;
  }
  async createAgent(spec: { name: string; runtime_id: string; model: string }): Promise<MulticaAgent> {
    if ([...this.agents, ...this.archivedAgents].some((a) => a.name === spec.name)) {
      throw new MulticaHttpError(409, `an agent named "${spec.name}" already exists in this workspace`);
    }
    const agent: MulticaAgent = { id: `agent-${this.agents.length + this.archivedAgents.length + 100}`, name: spec.name, model: spec.model, runtime_id: spec.runtime_id };
    this.agents.push(agent);
    return agent;
  }
  async archiveAgent(id: string): Promise<void> {
    const idx = this.agents.findIndex((a) => a.id === id);
    if (idx < 0) throw new MulticaHttpError(404, `no agent ${id}`);
    this.archivedAgents.push(...this.agents.splice(idx, 1));
  }
  async listComments(issueId: string): Promise<MulticaComment[]> {
    return this.comments.filter((c) => c.issue_id === issueId);
  }
  async cancelTask(taskId: string): Promise<void> {
    this.cancelled.push(taskId);
  }
  async getAgent(id: string): Promise<MulticaAgent> {
    const a = this.agents.find((x) => x.id === id);
    if (!a) throw new MulticaHttpError(404, `no agent ${id}`);
    return a;
  }
  agentEnvs = new Map<string, Record<string, string>>();
  async updateAgentEnv(agentId: string, env: Record<string, string>): Promise<void> {
    this.agentEnvs.set(agentId, env);
  }
  // eslint-disable-next-line require-yield
  async *watchWorkspace(): AsyncIterable<MulticaWsFrame> {
    return;
  }
}

const make = () => {
  const api = new FakeMulticaApi();
  const substrate = new MulticaSubstrate(api, {
    projectScope: "ws-1",
    roleAgents: { worker: { agentId: "agent-1", agentName: "worker-agent" } },
    selfMemberId: "member-self",
    operatorMemberIds: [],
  });
  return { api, substrate };
};

describe("createWorkItem", () => {
  it("creates an issue carrying the engagement marker and assigns the role's agent", async () => {
    const { api, substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-1"));
    const issue = await api.getIssue(ref.externalId);
    expect(issue.description).toContain("guild:engagement=eng-1");
    expect(issue.assignee_id).toBe("agent-1");
    expect(ref.substrate).toBe("multica");
  });

  it("writes the engagement marker LAST: an assign failure leaves nothing findWorkItem can find", async () => {
    const { api, substrate } = make();
    const realUpdate = api.updateIssue.bind(api);
    let updates = 0;
    api.updateIssue = async (id, patch) => {
      if (++updates === 1) throw new MulticaHttpError(500, "assign blew up");
      return realUpdate(id, patch);
    };
    await expect(substrate.createWorkItem(spec("eng-atomic"))).rejects.toMatchObject({
      category: "substrate_internal",
    });
    expect(await substrate.findWorkItem("eng-atomic")).toBeNull();
  });

  it("compensates when the marker write fails after assignment: cancels started work, closes the issue, stays unfindable", async () => {
    const { api, substrate } = make();
    const realUpdate = api.updateIssue.bind(api);
    api.updateIssue = async (id, patch) => {
      if (patch.description) {
        api.runs.set(id, [{ id: "r-live", issue_id: id, agent_id: "agent-1", status: "running", created_at: "t" }]);
        throw new MulticaHttpError(500, "marker write blew up");
      }
      return realUpdate(id, patch);
    };
    await expect(substrate.createWorkItem(spec("eng-marker"))).rejects.toMatchObject({
      category: "substrate_internal",
    });
    expect(api.cancelled).toEqual(["r-live"]);
    expect([...api.issues.values()][0]!.status).toBe("done");
    expect(await substrate.findWorkItem("eng-marker")).toBeNull();
  });

  it("rejects an unbound role as unsupported_capability naming the role", async () => {
    const { substrate } = make();
    const err = await substrate.createWorkItem(spec("eng-1", "astrologer")).catch((e) => e);
    expect(isSubstrateError(err)).toBe(true);
    expect(err.category).toBe("unsupported_capability");
    expect(err.message).toContain("astrologer");
  });
});

describe("findWorkItem (dispatch-saga idempotency)", () => {
  it("finds a previously created work item by engagement id", async () => {
    const { substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-42"));
    expect(await substrate.findWorkItem("eng-42")).toEqual(ref);
  });

  it("returns null when no work item carries the engagement id", async () => {
    const { substrate } = make();
    expect(await substrate.findWorkItem("eng-none")).toBeNull();
  });

  it("ignores a planted marker-bearing issue authored by anyone but the conductor (A5a)", async () => {
    // an agent can read the public idea id and derive a gate marker; a planted
    // issue carrying it must never be bound as the conductor's gate/engagement —
    // Guild only ever looks up items IT created
    const { api, substrate } = make();
    api.issues.set("planted", {
      id: "planted",
      title: "totally legit gate",
      description: "plan\n\n<!-- guild:engagement=gate:stg:idea-1:analysis:v1 -->",
      status: "todo",
      assignee_id: null,
      creator_type: "agent",
      creator_id: "agent-1",
      updated_at: "2026-07-31T12:00:00Z",
    });
    expect(await substrate.findWorkItem("gate:stg:idea-1:analysis:v1")).toBeNull();
  });

  it("still finds the conductor's own marked item (A5a does not break idempotency)", async () => {
    const { substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-77"));
    expect(await substrate.findWorkItem("eng-77")).toEqual(ref);
  });
});

describe("getWorkItem / listWorkItems", () => {
  it("derives the snapshot from issue + task runs", async () => {
    const { api, substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-1"));
    api.runs.set(ref.externalId, [
      {
        id: "abcd1234-run",
        issue_id: ref.externalId,
        agent_id: "agent-1",
        status: "completed",
        created_at: "2026-07-31T12:01:00Z",
        completed_at: "2026-07-31T12:02:00Z",
        result: { output: "Done.", pr_url: "", session_id: "s", work_dir: "w" },
      },
    ]);
    const snap = await substrate.getWorkItem(ref);
    expect(snap.status).toBe("done");
    expect(snap.report?.branchHint).toBe("agent/worker-agent/abcd1234");
  });

  it("lists the WHOLE board — marker-less operator tickets are idea candidates (D12), markers exposed", async () => {
    // pre-M2b this filtered to guild-marked items; idea detection needs the
    // full board, and the conductor does marker discipline via snapshot.markerId
    const { api, substrate } = make();
    await api.createIssue({ title: "human idea", description: "no marker here" });
    await substrate.createWorkItem(spec("eng-1"));
    const items = await substrate.listWorkItems("ws-1");
    expect(items).toHaveLength(2);
    const markers = items.map((s) => s.markerId).sort();
    expect(markers).toEqual(["eng-1", undefined]);
  });

  it("wraps a missing issue as a not_found substrate error", async () => {
    const { substrate } = make();
    const err = await substrate
      .getWorkItem({ substrate: "multica", externalId: "ghost" })
      .catch((e) => e);
    expect(isSubstrateError(err)).toBe(true);
    expect(err.category).toBe("not_found");
    expect(err.retryable).toBe(false);
  });
});

describe("comment / requestRework", () => {
  it("threads a reply when inReplyTo is given, top-level otherwise", async () => {
    const { api, substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-1"));
    await substrate.comment(ref, "hello");
    await substrate.comment(ref, "reply", { inReplyTo: api.comments[0]!.id });
    expect(api.comments[0]!.parent_id).toBeNull();
    expect(api.comments[1]!.parent_id).toBe(api.comments[0]!.id);
  });

  it("posts the bounce as a top-level comment carrying the failing detail (P5)", async () => {
    const { api, substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-1"));
    const verdict: ContractVerdict = {
      engagementId: "eng-1",
      contractId: "c1",
      contractVersion: 1,
      commitSha: "cafe0000",
      outcome: "failed",
      checkedAt: "2026-07-31T12:03:00Z",
      results: [
        {
          check: { kind: "command", run: "pnpm test", expectExitCode: 0, timeoutSeconds: 60 },
          outcome: "failed",
          detail: "1 test failed",
        },
      ],
    };
    await substrate.requestRework(ref, verdict);
    const bounce = api.comments.at(-1)!;
    expect(bounce.parent_id).toBeNull();
    expect(bounce.content).toContain("1 test failed");
  });
});

describe("cancel semantics (P4)", () => {
  it("cancels every non-terminal task run", async () => {
    const { api, substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-1"));
    api.runs.set(ref.externalId, [
      { id: "r1", issue_id: ref.externalId, agent_id: "a", status: "running", created_at: "t" },
      { id: "r2", issue_id: ref.externalId, agent_id: "a", status: "queued", created_at: "t" },
      { id: "r3", issue_id: ref.externalId, agent_id: "a", status: "completed", created_at: "t" },
    ]);
    await substrate.cancel(ref, "operator");
    expect(api.cancelled.sort()).toEqual(["r1", "r2"]);
  });

  it("is a no-op when every run is terminal — conductor retries are safe", async () => {
    const { api, substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-1"));
    api.runs.set(ref.externalId, [
      { id: "r1", issue_id: ref.externalId, agent_id: "a", status: "cancelled", created_at: "t" },
    ]);
    await substrate.cancel(ref, "operator");
    await substrate.cancel(ref, "operator");
    expect(api.cancelled).toEqual([]);
  });
});

describe("watch scope faults (async-generator semantics)", () => {
  it("surfaces a scope mismatch lazily on first pull, not at call time", async () => {
    const { substrate } = make();
    const stream = substrate.watch("wrong-scope"); // must not throw here
    const err = await stream[Symbol.asyncIterator]()
      .next()
      .catch((e: unknown) => e);
    expect(isSubstrateError(err)).toBe(true);
    expect((err as { category: string }).category).toBe("desync");
  });
});

describe("close (advisory bookkeeping, P6)", () => {
  it("marks the issue done by default", async () => {
    const { api, substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-1"));
    await substrate.close(ref);
    expect((await api.getIssue(ref.externalId)).status).toBe("done");
  });

  it("closes cancelled work in the cancelled status, never Done (B9)", async () => {
    const { api, substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-1"));
    await substrate.close(ref, "cancelled");
    expect((await api.getIssue(ref.externalId)).status).toBe("cancelled");
  });
});

describe("bindEngagementKey", () => {
  it("routes the role's runtime through the engagement key via the env hook", async () => {
    const { api, substrate } = make();
    await substrate.bindEngagementKey("worker", "sk-engagement-1");
    expect(api.agentEnvs.get("agent-1")).toEqual({ GUILD_DAEMON_VIRTUAL_KEY: "sk-engagement-1" });
  });

  it("classifies an unbound role as unsupported_capability", async () => {
    const { substrate } = make();
    const err = await substrate.bindEngagementKey("stranger", "sk-x").catch((x) => x);
    expect(isSubstrateError(err)).toBe(true);
    expect(err.category).toBe("unsupported_capability");
  });
});

describe("listComments (#12 reconcile read)", () => {
  it("maps comments with the SAME fail-closed actor attribution as the live event path (D15)", async () => {
    const api = new FakeMulticaApi();
    const substrate = new MulticaSubstrate(api, {
      projectScope: "ws-1",
      roleAgents: { worker: { agentId: "agent-1", agentName: "worker-agent" } },
      selfMemberId: "member-self",
      operatorMemberIds: ["member-op"],
    });
    const ref = await substrate.createWorkItem(spec("eng-9"));
    api.comments.push(
      { id: "c1", issue_id: ref.externalId, content: "amend: tighter", parent_id: null, author_type: "member", author_id: "member-op", created_at: "t1" },
      { id: "c2", issue_id: ref.externalId, content: "pushed", parent_id: null, author_type: "agent", author_id: "agent-1", created_at: "t2" },
      // no author_id on the wire → attribution fails closed, never operator
      { id: "c3", issue_id: ref.externalId, content: "amend: forged", parent_id: null, author_type: "member", created_at: "t3" },
      { id: "c4", issue_id: ref.externalId, content: "self", parent_id: "c1", author_type: "member", author_id: "member-self", created_at: "t4" },
    );
    const comments = await substrate.listComments(ref);
    expect(comments.map((c) => c.actor)).toEqual(["operator", "agent", "unknown", "conductor"]);
    expect(comments[0]).toMatchObject({ commentId: "c1", author: "member-op", body: "amend: tighter", at: "t1", inReplyTo: null });
    expect(comments[3].inReplyTo).toBe("c1");
  });
});

describe("archived-agent tolerance (M3: retire = archive; reads must survive)", () => {
  const hireAndAssign = async () => {
    const { api, substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-arch"));
    // a HIRED agent is not in the roleAgents name cache — resolution must go
    // through the API, which 404s once the agent is archived
    api.agents.push({ id: "agent-hired", name: "guild-hired-x", model: "m", runtime_id: "rt-1" });
    (await api.getIssue(ref.externalId)).assignee_id = "agent-hired";
    return { api, substrate, ref };
  };

  it("resolves an archived assignee via the archived listing instead of aborting the read path", async () => {
    const { api, substrate, ref } = await hireAndAssign();
    const idx = api.agents.findIndex((a) => a.id === "agent-hired");
    api.archivedAgents.push(...api.agents.splice(idx, 1));
    const snap = await substrate.getWorkItem(ref);
    expect(snap.item).toEqual(ref);
  });

  it("degrades to the bare agent id when the agent is gone entirely — never a thrown read", async () => {
    const { api, substrate, ref } = await hireAndAssign();
    const idx = api.agents.findIndex((a) => a.id === "agent-hired");
    api.agents.splice(idx, 1);
    const snap = await substrate.getWorkItem(ref);
    expect(snap.item).toEqual(ref);
  });
});
