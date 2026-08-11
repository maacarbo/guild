/**
 * Step definitions for the M2a acceptance (features/m2a-governed-engagement.feature).
 * Live Tier 1 stack, real substrate, real agent, real gateway keys, real
 * docker-run validation, real Postgres governance state.
 *
 * Two identities (D11): the CONDUCTOR runs under its own admin member
 * (conductor@guild.local — invitation flow live-proven 2026-08-02); the
 * OPERATOR's board moves come from the operator member, so lane_moved frames
 * carry genuine operator attribution.
 *
 * Conductor A is event-driven and killed mid-engagement; conductor B is
 * driven ONLY by reconcile() polling — recovery from reads, no event stream.
 *
 * Module-singleton world — same caveat as m1-smoke.steps.ts: one scenario,
 * no retry.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Given, Then, When, setDefaultTimeout } from "@cucumber/cucumber";
import pg from "pg";
import type { ExecutionSubstrate, StagePlan, WorkItemRef } from "@guild/shared";
import { createMulticaSubstrate } from "@guild/substrate-multica";
import {
  acquireMemberToken,
  bootstrapLiveEnv,
  ensureAgent,
  ensureWorkspaceMember,
} from "@guild/substrate-multica/testkit";
import { Conductor } from "../../src/application/conductor.js";
import { GitSourceControl } from "../../src/adapters/git-source-control.js";
import { LiteLlmModelGateway } from "../../src/adapters/litellm-gateway.js";
import { PgGovernanceStore } from "../../src/adapters/pg-governance-store.js";
import type { DecisionEntry } from "../../src/domain/decisions.js";
import { createContractValidator } from "../../src/index.js";

setDefaultTimeout(20 * 60 * 1000);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SCRATCH_REPO = process.env.GUILD_SCRATCH_REPO ?? "git@github.com:maacarbo/guild-scratch-m1a";
const MULTICA_URL = process.env.GUILD_MULTICA_URL ?? "http://127.0.0.1:8080";
const GATEWAY_URL = process.env.GUILD_GATEWAY_URL ?? "http://127.0.0.1:4000";

function envValue(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const env = readFileSync(join(repoRoot, "deploy", "compose", ".env"), "utf8");
  const m = new RegExp(`^${name}=(.+)$`, "m").exec(env);
  if (!m) throw new Error(`${name} not found (env or deploy/compose/.env)`);
  return m[1]!.trim();
}

const runId = Date.now().toString(36);
const engagementId = `m2a-${runId}`;

const world = {
  runId,
  engagementId,
  operatorToken: "",
  workspaceId: "",
  substrate: null as ExecutionSubstrate | null,
  gateway: null as LiteLlmModelGateway | null,
  source: new GitSourceControl(),
  plan: null as StagePlan | null,
  storeA: null as PgGovernanceStore | null,
  storeB: null as PgGovernanceStore | null,
  conductorA: null as Conductor | null,
  conductorB: null as Conductor | null,
  abortA: new AbortController(),
  runA: null as Promise<void> | null,
  gate: null as WorkItemRef | null,
  item: null as WorkItemRef | null,
  validatedSha: "",
};

function pgUrl(): string {
  return `postgres://guild:${encodeURIComponent(envValue("GUILD_POSTGRES_PASSWORD"))}@127.0.0.1:5442/guild`;
}

async function operatorMovesTicket(externalId: string, status: string): Promise<void> {
  const res = await fetch(`${MULTICA_URL}/api/issues/${externalId}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${world.operatorToken}`,
      "x-workspace-id": world.workspaceId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ status }),
  });
  assert.ok(res.ok, `operator lane move → ${res.status}`);
}

async function decisions(store: PgGovernanceStore): Promise<DecisionEntry[]> {
  return store.listDecisions();
}

/** drive conductor B by reads until cond holds — recovery is reconciliation, not events */
async function reconcileUntil(cond: (ds: DecisionEntry[]) => Promise<boolean> | boolean, what: string, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    await world.conductorB!.reconcile();
    if (await cond(await decisions(world.storeB!))) return;
    assert.ok(Date.now() < deadline, `timeout waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

function makeConductor(store: PgGovernanceStore): Conductor {
  const workRoot = join(repoRoot, ".cache", "validator");
  mkdirSync(workRoot, { recursive: true });
  return new Conductor(
    {
      substrate: world.substrate!,
      gateway: world.gateway!,
      validator: createContractValidator({ workRoot, image: "alpine:3.22" }),
      source: world.source,
      store,
    },
    {
      projectScope: world.workspaceId,
      repoUrl: SCRATCH_REPO,
      targetBranch: "main",
      defaultPlanBudgetCents: 50,
    },
  );
}

Given("the live stack, a governed workspace, and a hand-authored stage plan", async () => {
  const health = await (await fetch(`${MULTICA_URL}/healthz`)).json();
  assert.equal(health.status, "ok", "multica backend healthy");

  // operator identity (workspace owner) — also verifies the daemon is up
  const operator = await bootstrapLiveEnv();
  world.operatorToken = operator.token;
  world.workspaceId = operator.workspaceId;

  // conductor identity: own member, admin role (D11; invitation flow P-proven)
  const conductor = await acquireMemberToken(operator.baseUrl, "conductor@guild.local", "guild-conductor-token.json");
  await ensureWorkspaceMember(operator.baseUrl, operator.token, operator.workspaceId, {
    token: conductor.token,
    email: "conductor@guild.local",
    role: "admin",
  });
  const worker = await ensureAgent(operator.baseUrl, conductor.token, operator.workspaceId, {
    name: "guild-m2a-worker",
    model: process.env.GUILD_SMOKE_MODEL ?? "litellm/or-deepseek-v3-2",
  });

  world.substrate = createMulticaSubstrate(
    { baseUrl: operator.baseUrl, token: conductor.token, workspaceId: operator.workspaceId },
    {
      projectScope: operator.workspaceId,
      roleAgents: { implementer: { agentId: worker.agentId, agentName: worker.agentName } },
      selfMemberId: conductor.memberId,
      // the workspace-owner member is the operator; its board moves are the genuine
      // operator-attributed gate triggers (D15 allowlist)
      operatorMemberIds: [operator.memberId],
    },
  );
  world.gateway = new LiteLlmModelGateway({ baseUrl: GATEWAY_URL, masterKey: envValue("LITELLM_MASTER_KEY") });

  // the acceptance owns the dev governance DB — start from a clean slate
  const pool = new pg.Pool({ connectionString: pgUrl(), max: 1 });
  await pool
    .query(
      "TRUNCATE engagements, decisions, dispatch_intents, gate_tickets, gate_decisions, plan_runs, stage_plans, dispatch_lock",
    )
    .catch((e: unknown) => {
      // first run: tables may not exist yet (undefined_table); anything else
      // must fail the run — a silently-skipped TRUNCATE leaves stale rows (#11)
      if ((e as { code?: string }).code !== "42P01") throw e;
    });
  await pool.end();
  world.storeA = await PgGovernanceStore.connect(pgUrl());

  const governed = `governed:${runId}`;
  const evidence = `evidence:${runId}`;
  world.plan = {
    projectId: "guild-m2a",
    stageId: `stage-${runId}`,
    planVersion: 1,
    kind: "implementation",
    objective: `deliver the governed artifact ${runId}`,
    budgetCents: 50,
    engagements: [
      {
        engagementId,
        role: "implementer",
        title: `m2a governed engagement ${runId}`,
        budgetCents: 50,
        brief: {
          roleContext: "You are the implementation engineer for this engagement.",
          instructions: [
            "This is iteration 1 of a two-iteration engagement. In this iteration, do exactly this and nothing else:",
            "",
            "1. Reply with the single word ACK.",
            "",
            "Do NOT create or modify any files in this iteration. Do NOT run git. The implementation happens in iteration 2, after review — the review comment will tell you to proceed.",
          ].join("\n"),
          contract: {
            contractId: `contract-${runId}`,
            version: 1,
            authoredBy: "architect",
            gherkin: [
              "Feature: governed delivery",
              "  Scenario: the governed artifacts are delivered",
              "    Given the engagement branch is checked out at the reported commit",
              `    Then GOVERNED-${runId}.md contains "${governed}"`,
              `    And EVIDENCE-${runId}.md contains "${evidence}"`,
            ].join("\n"),
            checks: [
              { kind: "artifact", path: `GOVERNED-${runId}.md`, mustContain: governed },
              { kind: "artifact", path: `EVIDENCE-${runId}.md`, mustContain: evidence },
            ],
          },
          priorDecisions: [],
          artifactRefs: [],
          constraints: [`Touch only GOVERNED-${runId}.md and EVIDENCE-${runId}.md.`],
        },
      },
    ],
  };
  world.conductorA = makeConductor(world.storeA);
});

When("the conductor posts the stage for approval", async () => {
  await world.conductorA!.adoptStagePlan(world.plan!);
  world.gate = await world.conductorA!.postStageForApproval(world.plan!.stageId);
  const snap = await world.substrate!.getWorkItem(world.gate);
  assert.equal(snap.lane, "waiting_for_feedback", "gate ticket awaits the operator");
  // event-driven conductor A takes over from here
  world.runA = world.conductorA!.run({ signal: world.abortA.signal }).catch(() => undefined);
});

When("the operator approves the plan by moving the gate ticket to Ready to work", async () => {
  await operatorMovesTicket(world.gate!.externalId, "todo");
});

Then("the conductor dispatches the engagement with a budget-capped key", async () => {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const ds = await decisions(world.storeA!);
    if (ds.some((d) => d.kind === "dispatch")) break;
    assert.ok(Date.now() < deadline, "conductor A never dispatched after the operator's approval");
    await new Promise((r) => setTimeout(r, 2000));
  }
  const rec = await world.storeA!.getEngagement(engagementId);
  assert.ok(rec?.item, "engagement has a work item");
  world.item = rec!.item!;
  const spend = await world.gateway!.getSpend(engagementId);
  assert.ok(spend, "engagement key exists");
  assert.equal(spend.budgetCents, 50, "engagement key minted with the plan's cap");
});

When("the conductor is killed mid-engagement and a fresh conductor takes over from reads", async () => {
  world.abortA.abort();
  await world.runA;
  await world.storeA!.close();
  // the replacement shares nothing in-process with A but the config: state
  // comes back from Postgres + substrate reads only
  world.storeB = await PgGovernanceStore.connect(pgUrl());
  world.conductorB = makeConductor(world.storeB);
});

Then("the hollow first report fails validation and bounces with the failing criteria", async () => {
  await reconcileUntil(
    (ds) => ds.some((d) => d.kind === "bounce"),
    "the hollow completion to be judged and bounced",
    8 * 60 * 1000,
  );
  const ds = await decisions(world.storeB!);
  const failed = ds.find((d) => d.kind === "verdict" && d.verdict.outcome === "failed");
  assert.ok(failed, "a failed verdict is on the trail");
  const rec = await world.storeB!.getEngagement(engagementId);
  assert.equal(rec?.bounceCount, 1);
});

Then("the agent's rework validates cleanly at a pinned commit", async () => {
  await reconcileUntil(
    async () => (await world.storeB!.getEngagement(engagementId))?.state === "validated",
    "the rework to pass validation",
    10 * 60 * 1000,
  );
  const rec = await world.storeB!.getEngagement(engagementId);
  assert.match(rec!.validatedSha ?? "", /^[0-9a-f]{40}$/, "validated at a pinned commit");
  world.validatedSha = rec!.validatedSha!;
});

When("the operator accepts by moving the engagement ticket to Done", async () => {
  await operatorMovesTicket(world.item!.externalId, "done");
  await reconcileUntil(
    async () => (await world.storeB!.getEngagement(engagementId))?.state === "accepted",
    "the acceptance to terminate the engagement",
    2 * 60 * 1000,
  );
});

Then("the target branch fast-forwards to exactly the validated commit", async () => {
  const mainSha = await world.source.resolveRemoteSha(SCRATCH_REPO, "main");
  assert.equal(mainSha, world.validatedSha, "main is exactly the validated commit");
});

Then("the decision trail records the complete governed lifecycle", async () => {
  // #11: every assertion is scoped to THIS run's stage/engagement — stale
  // rows (or another plan's entries) can never satisfy the lifecycle bar
  const stageId = world.plan!.stageId;
  const ds = (await decisions(world.storeB!)).filter((d) => {
    switch (d.kind) {
      case "gate_posted":
        return d.stageId === stageId;
      case "gate":
        return d.decision.stageId === stageId;
      case "dispatch":
        return d.outcome.engagementId === engagementId;
      case "transition":
      case "verdict":
        return d.engagementId === engagementId;
      case "bounce":
        return d.outcome.engagementId === engagementId;
      case "termination":
        return d.terminated.engagementId === engagementId;
      default:
        return false;
    }
  });
  const kinds = new Set(ds.map((d) => d.kind));
  for (const k of ["gate_posted", "gate", "dispatch", "verdict", "bounce", "termination"]) {
    assert.ok(kinds.has(k as DecisionEntry["kind"]), `trail has a ${k} entry`);
  }
  const outcomes = ds.filter((d) => d.kind === "verdict").map((d) => d.verdict.outcome);
  assert.ok(outcomes.includes("failed") && outcomes.includes("passed"), "both verdicts on the trail");
  const term = ds.find((d) => d.kind === "termination");
  assert.equal(term!.terminated.finalState, "accepted");

  const pairs = ds.filter((d) => d.kind === "transition").map((d) => `${d.from}→${d.to}`);
  for (const p of [
    "planned→gated",
    "gated→dispatched",
    "dispatched→working",
    "working→reported",
    "reported→bounced",
    "bounced→working",
    "reported→validated",
    "validated→accepted",
  ]) {
    assert.ok(pairs.includes(p), `transition ${p} recorded (got: ${pairs.join(", ")})`);
  }
  await world.storeB!.close();
});
