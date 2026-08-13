/**
 * Step definitions for the M2b acceptance (features/m2b-planner-team-watchdog.feature).
 * Live Tier 1 stack: real substrate, four real role agents on the daemon, real
 * gateway keys, real docker-run validation (node:22-alpine — the demo's floor
 * checks run `node --test` offline), real Postgres governance state.
 *
 * Two identities (D11): the conductor under its own admin member; every
 * approval, acceptance, and amendment comes from the operator member, so the
 * attribution the zero-discretion rule hinges on is genuine.
 *
 * Module-singleton world — same caveat as the other live features: one
 * scenario, no retry.
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { After, Given, Then, When, setDefaultTimeout } from "@cucumber/cucumber";
import pg from "pg";
import type { ExecutionSubstrate, StageKind, WorkItemRef } from "@guild/shared";
import { createMulticaSubstrate } from "@guild/substrate-multica";
import { acquireMemberToken, bootstrapLiveEnv, ensureAgent, ensureWorkspaceMember } from "@guild/substrate-multica/testkit";
import { Conductor } from "../../src/application/conductor.js";
import { GitSourceControl } from "../../src/adapters/git-source-control.js";
import { LiteLlmModelGateway } from "../../src/adapters/litellm-gateway.js";
import { PgGovernanceStore } from "../../src/adapters/pg-governance-store.js";
import { ensureIsolatedDatabase, isolatedDatabaseUrl } from "../../src/testkit/live-db.js";
import { STAGE_ORDER } from "../../src/domain/planner.js";
import type { DecisionEntry } from "../../src/domain/decisions.js";
import { createContractValidator } from "../../src/index.js";

setDefaultTimeout(20 * 60 * 1000);

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SCRATCH_REPO = process.env.GUILD_SCRATCH_REPO ?? "git@github.com:maacarbo/guild-scratch-m1a";
const MULTICA_URL = process.env.GUILD_MULTICA_URL ?? "http://127.0.0.1:8080";
const GATEWAY_URL = process.env.GUILD_GATEWAY_URL ?? "http://127.0.0.1:4000";
const VALIDATOR_IMAGE = process.env.GUILD_VALIDATOR_NODE_IMAGE ?? "node:22-alpine";
const AGENT_MODEL = process.env.GUILD_SMOKE_MODEL ?? "litellm/or-deepseek-v3-2";
const ROLES: readonly string[] = ["analyst", "architect", "implementer", "tester"];

function envValue(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const env = readFileSync(join(repoRoot, "deploy", "compose", ".env"), "utf8");
  const m = new RegExp(`^${name}=(.+)$`, "m").exec(env);
  if (!m) throw new Error(`${name} not found (env or deploy/compose/.env)`);
  return m[1]!.trim();
}

const world = {
  operatorToken: "",
  workspaceId: "",
  substrate: null as ExecutionSubstrate | null,
  gateway: null as LiteLlmModelGateway | null,
  source: new GitSourceControl(),
  store: null as PgGovernanceStore | null,
  conductor: null as Conductor | null,
  abort: new AbortController(),
  runLoop: null as Promise<void> | null,
  ideaId: "",
  gateV1: null as WorkItemRef | null,
  idea2Id: "",
  idea2Engagement: "",
};

function pgAdminUrl(): string {
  return `postgres://guild:${encodeURIComponent(envValue("GUILD_POSTGRES_PASSWORD"))}@127.0.0.1:5442/guild`;
}

// #27: the smoke truncates at start and leaves run state behind — it gets its
// own database so the compose conductor's governance state is untouchable
const pgUrl = (): string => isolatedDatabaseUrl(pgAdminUrl());

async function operatorApi(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${MULTICA_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${world.operatorToken}`,
      "x-workspace-id": world.workspaceId,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function operatorMovesTicket(externalId: string, status: string): Promise<void> {
  const res = await operatorApi("PUT", `/api/issues/${externalId}`, { status });
  assert.ok(res.ok, `operator lane move → ${res.status}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** poll with reconcile ticks — reads stay the truth path when frames drop */
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    assert.ok(Date.now() < deadline, `timeout waiting for: ${what}`);
    await sleep(10_000);
    await world.conductor!.reconcile().catch((e) => {
      console.warn(`reconcile tick failed (transient?): ${e instanceof Error ? e.message : e}`);
    });
  }
}

function stageIdOf(ideaId: string, kind: StageKind): string {
  return `stg:${ideaId}:${kind}`;
}

// a mid-scenario failure must not leave the watch loop and pg pool holding
// the process open — the happy path also lands here (abort is idempotent)
After(async () => {
  world.abort.abort();
  await world.runLoop?.catch(() => undefined);
  await world.store?.close().catch(() => undefined);
  // #27: with the smoke on its own database, the compose conductor has no
  // plan-run row for the demo idea — a live leftover would be re-adopted as a
  // fresh idea on the next reconcile; cancel it board-side
  if (world.ideaId) await operatorMovesTicket(world.ideaId, "cancelled").catch(() => undefined);
});

Given("the live stack, the four role agents, and a clean governance database", async () => {
  const health = await (await fetch(`${MULTICA_URL}/healthz`)).json();
  assert.equal(health.status, "ok", "multica backend healthy");

  const operator = await bootstrapLiveEnv();
  world.operatorToken = operator.token;
  world.workspaceId = operator.workspaceId;

  const conductor = await acquireMemberToken(operator.baseUrl, "conductor@guild.local", "guild-conductor-token.json");
  await ensureWorkspaceMember(operator.baseUrl, operator.token, operator.workspaceId, {
    token: conductor.token,
    email: "conductor@guild.local",
    role: "admin",
  });

  const roleAgents: Record<string, { agentId: string; agentName: string }> = {};
  for (const role of ROLES) {
    const agent = await ensureAgent(operator.baseUrl, conductor.token, operator.workspaceId, {
      name: `guild-m2b-${role}`,
      model: AGENT_MODEL,
    });
    roleAgents[role] = agent;
  }

  world.substrate = createMulticaSubstrate(
    { baseUrl: operator.baseUrl, token: conductor.token, workspaceId: operator.workspaceId },
    // the workspace-owner member is the operator; approvals/acceptances/amendments come
    // from it, so it is the allowlisted operator identity (D15)
    { projectScope: operator.workspaceId, roleAgents, selfMemberId: conductor.memberId, operatorMemberIds: [operator.memberId] },
  );
  world.gateway = new LiteLlmModelGateway({ baseUrl: GATEWAY_URL, masterKey: envValue("LITELLM_MASTER_KEY") });

  // deterministic adoption: cancel every ticket the conductor WOULD adopt as
  // an idea (live, marker-less, operator-authored) — through the substrate's
  // own fully-paginated board read, exactly the adoption filter (a naive
  // single-page GET misses old rows; found live 2026-08-03)
  for (const snap of await world.substrate.listWorkItems(operator.workspaceId)) {
    if (snap.lane === "cancelled" || snap.lane === "done") continue;
    if (snap.markerId || snap.createdBy !== "operator") continue;
    await operatorMovesTicket(snap.item.externalId, "cancelled");
  }

  // #35: the scratch repo is stateful across runs — analysis would validate at
  // a pre-existing SHA and re-gate architecture with a PREVIOUS run's handoff
  // checks (observed live 2026-08-13: the stale pre-fix handoff kept failing
  // every rerun). Every run starts from a clean baseline on main.
  {
    const dir = mkdtempSync(join(tmpdir(), "guild-m2b-reset-"));
    try {
      await exec("git", ["init", "--quiet", "-b", "main", dir], { timeout: 30_000 });
      writeFileSync(join(dir, "README.md"), "# guild-scratch — m2b smoke baseline\n");
      await exec("git", ["-C", dir, "add", "README.md"], { timeout: 30_000 });
      await exec(
        "git",
        ["-C", dir, "-c", "user.name=guild-smoke", "-c", "user.email=smoke@guild.local", "commit", "--quiet", "-m", "m2b smoke baseline"],
        { timeout: 30_000 },
      );
      await exec("git", ["-C", dir, "push", "--quiet", "--force", SCRATCH_REPO, "main"], { timeout: 120_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // the validator sandbox needs node for the demo floor checks
  await exec("docker", ["image", "inspect", VALIDATOR_IMAGE]).catch(() => exec("docker", ["pull", VALIDATOR_IMAGE]));

  await ensureIsolatedDatabase(pgAdminUrl());
  const pool = new pg.Pool({ connectionString: pgUrl(), max: 1 });
  await pool
    .query(
      "TRUNCATE engagements, decisions, dispatch_intents, gate_tickets, gate_decisions, plan_runs, stage_plans, dispatch_lock",
    )
    .catch((e: unknown) => {
      if ((e as { code?: string }).code !== "42P01") throw e;
    });
  await pool.end();
  world.store = await PgGovernanceStore.connect(pgUrl());

  const workRoot = join(repoRoot, ".cache", "validator");
  mkdirSync(workRoot, { recursive: true });
  world.conductor = new Conductor(
    {
      substrate: world.substrate!,
      gateway: world.gateway!,
      validator: createContractValidator({ workRoot, image: VALIDATOR_IMAGE }),
      source: world.source,
      store: world.store,
    },
    {
      projectScope: world.workspaceId,
      repoUrl: SCRATCH_REPO,
      targetBranch: "main",
      defaultPlanBudgetCents: 100,
    },
  );
  // reconnect on stream drop, mirroring the production bin: a single run()
  // call leaves the harness event-dead after one WS error, and amendment has
  // no reconcile fallback (issue #12) — found the hard way mid-revalidation
  world.runLoop = (async () => {
    while (!world.abort.signal.aborted) {
      try {
        await world.conductor!.run({ signal: world.abort.signal });
      } catch {
        // transient stream error — reconcile ticks cover the gap
      }
      if (!world.abort.signal.aborted) await sleep(3000);
    }
  })();
});

When("the operator posts the demo idea as a board ticket", async () => {
  const res = await operatorApi("POST", "/api/issues", {
    title: "Demo: word-count CLI",
    description: [
      "Build a tiny word-count command-line tool in this repository.",
      "",
      "Requirements: a Node.js >= 22 executable script bin/wc.mjs that prints the",
      "number of whitespace-separated words in a UTF-8 text file passed as its",
      "only argument; zero runtime dependencies; tests runnable offline with",
      "`node --test`.",
      "",
      // $5: headroom for a bounce-rework cycle per stage on the cheap tier —
      // a 2026-08-12 run hit a genuine bounce and the 15% architecture split
      // of $3 (45c) capped out mid-rework (the budget doing its job)
      "budget: 10.00",
    ].join("\n"),
  });
  assert.ok(res.ok, `idea ticket → ${res.status}`);
  world.ideaId = ((await res.json()) as { id: string }).id;
});

Then("the conductor answers with an analysis plan gate awaiting feedback", async () => {
  const marker = `gate:${stageIdOf(world.ideaId, "analysis")}:v1`;
  world.gateV1 = await waitFor(
    async () => {
      const ref = await world.substrate!.findWorkItem(marker);
      if (!ref) return null;
      const snap = await world.substrate!.getWorkItem(ref);
      return snap.lane === "waiting_for_feedback" ? ref : null;
    },
    "the analysis v1 gate in waiting-for-feedback",
    3 * 60 * 1000,
  );
  // the plan allocated 15% of the idea's $5 directive
  const plan = await world.store!.getStagePlan(stageIdOf(world.ideaId, "analysis"), 1);
  assert.equal(plan?.budgetCents, 150, "analysis v1 carries the mechanical allocation (15% of 1000¢)");
});

When("the operator amends the analysis plan with a budget directive", async () => {
  const res = await operatorApi("POST", `/api/issues/${world.gateV1!.externalId}/comments`, {
    // C4 grammar (#12): a budget: directive must be its own line — prose
    // trailing into "budget: X" deliberately never reprices
    content: "amend: sharpen the spec toward CLI ergonomics.\nbudget: 0.60",
  });
  assert.ok(res.ok, `amend comment → ${res.status}`);
});

Then("a version-2 analysis gate supersedes the first", async () => {
  const stageId = stageIdOf(world.ideaId, "analysis");
  await waitFor(
    async () => (await world.store!.getStagePlan(stageId, 2)) !== null,
    "the amended v2 plan",
    3 * 60 * 1000,
  );
  const v2 = (await world.store!.getStagePlan(stageId, 2))!;
  assert.equal(v2.budgetCents, 60, "the amendment repriced the stage");
  assert.ok(v2.objective.includes("CLI ergonomics"), "the note folded into the objective");
  assert.equal((await world.store!.getEngagement(`eng:${stageId}:v1`))?.state, "cancelled", "v1 superseded");
  const gate2 = await world.substrate!.findWorkItem(`gate:${stageId}:v2`);
  assert.ok(gate2, "v2 gate posted");
  assert.equal((await world.substrate!.getWorkItem(world.gateV1!)).lane, "cancelled", "v1 gate off-board");
});

When(
  "the operator approves each stage gate and accepts each validated stage",
  { timeout: 60 * 60 * 1000 },
  async () => {
    for (const kind of STAGE_ORDER) {
      const stageId = stageIdOf(world.ideaId, kind);
      const version = kind === "analysis" ? 2 : 1;
      const gate = await waitFor(
        async () => {
          const ref = await world.substrate!.findWorkItem(`gate:${stageId}:v${version}`);
          if (!ref) return null;
          return (await world.substrate!.getWorkItem(ref)).lane === "waiting_for_feedback" ? ref : null;
        },
        `the ${kind} v${version} gate`,
        5 * 60 * 1000,
      );
      await operatorMovesTicket(gate.externalId, "todo");

      const engagementId = `eng:${stageId}:v${version}`;
      const item = await waitFor(
        () => world.substrate!.findWorkItem(engagementId),
        `the ${kind} engagement ticket`,
        3 * 60 * 1000,
      );
      await waitFor(
        async () => (await world.store!.getEngagement(engagementId))?.state === "validated",
        `the ${kind} engagement to validate (agent work + SHA-pinned checks)`,
        15 * 60 * 1000,
      );
      await operatorMovesTicket(item.externalId, "done");
      await waitFor(
        async () => (await world.store!.getEngagement(engagementId))?.state === "accepted",
        `the ${kind} acceptance to terminate`,
        3 * 60 * 1000,
      );
      console.log(`  ✓ stage ${kind} accepted`);
    }
  },
);

Then(
  "the delivery is complete: main holds the demo product with passing tests and the idea ticket is Done",
  async () => {
    await waitFor(
      async () => (await world.store!.getPlanRun(world.ideaId))?.status === "completed",
      "the plan run to complete",
      3 * 60 * 1000,
    );
    const idea = await world.substrate!.getWorkItem({ substrate: "multica", externalId: world.ideaId });
    assert.equal(idea.lane, "done", "the idea ticket landed in Done");

    // the M2 bar, asserted directly: a fresh clone of main passes its tests.
    // Color env is scrubbed: this driver shell exports FORCE_COLOR, which the
    // demo CLI would inherit and ANSI-wrap its output — a cosmetic artifact of
    // the harness environment, not of the product (found live 2026-08-03; the
    // sandboxed validator env is neutral and passed the same tree).
    const neutral: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete neutral.FORCE_COLOR;
    const dir = mkdtempSync(join(tmpdir(), "guild-m2b-final-"));
    try {
      await exec("git", ["clone", "--depth", "1", SCRATCH_REPO, dir], { timeout: 120_000 });
      await exec("node", ["--test"], { cwd: dir, timeout: 120_000, env: neutral });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

Then("the decision trail records five gated stages with zero un-contracted advances", async () => {
  const ds = await world.store!.listDecisions();
  const stageIds = STAGE_ORDER.map((kind) => stageIdOf(world.ideaId, kind));

  for (const stageId of stageIds) {
    assert.ok(
      ds.some((d) => d.kind === "gate_posted" && d.stageId === stageId),
      `gate posted for ${stageId}`,
    );
    assert.ok(
      ds.some((d) => d.kind === "gate" && d.decision.kind === "approved" && d.decision.stageId === stageId),
      `operator approval recorded for ${stageId}`,
    );
  }

  // zero un-contracted advances: every dispatch follows a recorded approval of
  // exactly its stage+version, and every acceptance follows a passed verdict
  const approvedAt = new Map<string, number>();
  ds.forEach((d, i) => {
    if (d.kind === "gate" && d.decision.kind === "approved") {
      approvedAt.set(`${d.decision.stageId}:v${d.decision.planVersion}`, i);
    }
  });
  const dispatches = ds.flatMap((d, i) =>
    d.kind === "dispatch" && d.outcome.kind === "dispatched" ? [{ id: d.outcome.engagementId, i }] : [],
  );
  // Run-scoped EXACT counts (#12): `>= 5` over the whole store could never
  // catch a duplicate dispatch. Every stage dispatches exactly once at its
  // expected version (analysis is v2 — the scenario amends it pre-approval),
  // and no OTHER engagement of this idea dispatched at all.
  const counts = new Map<string, number>();
  for (const { id } of dispatches) {
    if (!id.startsWith(`eng:stg:${world.ideaId}:`)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const stageId of stageIds) {
    const version = stageId.endsWith(":analysis") ? 2 : 1;
    const engagementId = `eng:${stageId}:v${version}`;
    assert.equal(counts.get(engagementId), 1, `exactly one dispatch of ${engagementId} (got ${counts.get(engagementId) ?? 0})`);
  }
  assert.equal(
    counts.size,
    stageIds.length,
    `no unexpected dispatches for ${world.ideaId} (saw: ${[...counts.keys()].sort().join(", ")})`,
  );
  for (const { id, i } of dispatches) {
    if (!id.startsWith(`eng:stg:${world.ideaId}:`)) continue;
    // engagement ids are `eng:<stageId>:v<n>` — strip the prefix to get the approval key
    const gateIdx = approvedAt.get(id.replace(/^eng:/, ""));
    assert.ok(gateIdx !== undefined && gateIdx < i, `dispatch of ${id} follows its gate approval`);
  }
  for (const stageId of stageIds) {
    const version = stageId.endsWith(":analysis") ? 2 : 1;
    const engagementId = `eng:${stageId}:v${version}`;
    const passedIdx = ds.findIndex(
      (d) => d.kind === "verdict" && d.engagementId === engagementId && d.verdict.outcome === "passed",
    );
    const acceptedIdx = ds.findIndex(
      (d) => d.kind === "termination" && d.terminated.engagementId === engagementId && d.terminated.finalState === "accepted",
    );
    assert.ok(passedIdx >= 0, `passed verdict for ${engagementId}`);
    assert.ok(acceptedIdx > passedIdx, `acceptance of ${engagementId} follows its passed verdict`);
  }
});

When("the operator posts a second idea whose analysis is approved and dispatched", async () => {
  const res = await operatorApi("POST", "/api/issues", {
    title: "Demo: line-count CLI (overspend fixture)",
    description: "A second tiny tool: count lines instead of words.\n\nbudget: 0.50",
  });
  assert.ok(res.ok, `second idea → ${res.status}`);
  world.idea2Id = ((await res.json()) as { id: string }).id;

  const stageId = stageIdOf(world.idea2Id, "analysis");
  const gate = await waitFor(
    async () => {
      const ref = await world.substrate!.findWorkItem(`gate:${stageId}:v1`);
      if (!ref) return null;
      return (await world.substrate!.getWorkItem(ref)).lane === "waiting_for_feedback" ? ref : null;
    },
    "the second idea's analysis gate",
    3 * 60 * 1000,
  );
  await operatorMovesTicket(gate.externalId, "todo");
  world.idea2Engagement = `eng:${stageId}:v1`;
  await waitFor(
    async () => {
      const state = (await world.store!.getEngagement(world.idea2Engagement))?.state;
      return state === "dispatched" || state === "working";
    },
    "the second analysis engagement in flight",
    3 * 60 * 1000,
  );
});

When("the budget watchdog sweeps under a one-cent project hard cap", async () => {
  // the same governance state seen by a conductor whose configured project
  // ceiling the demo's recorded spend already exceeds (raise/lower-the-cap
  // is a config-and-restart operation, D12)
  const capped = new Conductor(
    {
      substrate: world.substrate!,
      gateway: world.gateway!,
      validator: createContractValidator({ workRoot: join(repoRoot, ".cache", "validator"), image: VALIDATOR_IMAGE }),
      source: world.source,
      store: world.store!,
    },
    {
      projectScope: world.workspaceId,
      repoUrl: SCRATCH_REPO,
      targetBranch: "main",
      defaultPlanBudgetCents: 100,
      projectBudget: { projectId: world.workspaceId, softCapCents: 1, hardCapCents: 1 },
    },
  );
  await capped.sweep();
});

Then("the overspend halts cleanly: work cancelled, dispatch locked, explanation posted", async () => {
  const rec = await world.store!.getEngagement(world.idea2Engagement);
  assert.equal(rec?.state, "cancelled", "the in-flight engagement was cancelled");

  const lock = await world.store!.getDispatchLock();
  assert.ok(lock && /budget_hard_cap/.test(lock.reason), "dispatch is locked with the budget reason");

  const ds = await world.store!.listDecisions();
  const hard = ds.find((d) => d.kind === "budget" && d.event.kind === "hard_cap");
  assert.ok(hard, "the hard_cap budget decision is on the trail");
  assert.ok(
    hard!.kind === "budget" && hard!.event.kind === "hard_cap" && hard!.event.cancelled.includes(world.idea2Engagement),
    "the halt names the cancelled engagement",
  );
  const term = ds.find(
    (d) =>
      d.kind === "termination" &&
      d.terminated.engagementId === world.idea2Engagement &&
      d.terminated.reason === "budget_hard_cap",
  );
  assert.ok(term, "termination recorded with the budget reason");

  // the visible explanation (an idea-ticket comment from the conductor)
  const commentRes = (await operatorApi("GET", `/api/issues/${world.idea2Id}/comments`).then((r) => r.json())) as
    | Array<{ content: string }>
    | { comments: Array<{ content: string }> };
  const comments = Array.isArray(commentRes) ? commentRes : (commentRes.comments ?? []);
  assert.ok(
    comments.some((c) => /hard cap/i.test(c.content)),
    "the halt explains itself on the idea ticket",
  );

  // leave the board clean for the next run: the halted idea goes off-board
  // (loop/store teardown lives in the After hook — it must run on failure too)
  await operatorMovesTicket(world.idea2Id, "cancelled");
});
