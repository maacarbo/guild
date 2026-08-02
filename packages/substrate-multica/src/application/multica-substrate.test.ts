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
  private seq = 0;

  async createIssue(input: { title: string; description: string }): Promise<MulticaIssue> {
    const issue: MulticaIssue = {
      id: `issue-${++this.seq}`,
      title: input.title,
      description: input.description,
      status: "todo",
      assignee_id: null,
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

  it("lists only guild-marked work items, not foreign issues in the workspace", async () => {
    const { api, substrate } = make();
    await api.createIssue({ title: "human issue", description: "no marker" });
    await substrate.createWorkItem(spec("eng-1"));
    const items = await substrate.listWorkItems("ws-1");
    expect(items).toHaveLength(1);
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
  it("marks the issue done", async () => {
    const { api, substrate } = make();
    const ref = await substrate.createWorkItem(spec("eng-1"));
    await substrate.close(ref);
    expect((await api.getIssue(ref.externalId)).status).toBe("done");
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
