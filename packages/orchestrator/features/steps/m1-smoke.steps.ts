/**
 * Step definitions for the M1 acceptance scenario (features/m1-smoke.feature).
 * Everything runs against the live Tier 1 stack: real substrate, real agent,
 * real gateway key, real docker-run validation. Cheap model tier only.
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Given, Then, When, setDefaultTimeout } from "@cucumber/cucumber";
import type {
  EngagementKey,
  ExecutionSubstrate,
  HandoffContract,
  SubstrateEvent,
  WorkItemRef,
} from "@guild/shared";
import { createMulticaSubstrate } from "@guild/substrate-multica";
import { bootstrapLiveEnv } from "@guild/substrate-multica/testkit";
import { LiteLlmModelGateway } from "../../src/adapters/litellm-gateway.js";
import { createContractValidator } from "../../src/index.js";

setDefaultTimeout(9 * 60 * 1000);

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SCRATCH_REPO = process.env.GUILD_SCRATCH_REPO ?? "git@github.com:maacarbo/guild-scratch-m1a";
const MULTICA_URL = process.env.GUILD_MULTICA_URL ?? "http://127.0.0.1:8080";
const GATEWAY_URL = process.env.GUILD_GATEWAY_URL ?? "http://127.0.0.1:4000";

function masterKey(): string {
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  const env = readFileSync(join(repoRoot, "deploy", "compose", ".env"), "utf8");
  const m = /^LITELLM_MASTER_KEY=(.+)$/m.exec(env);
  if (!m) throw new Error("LITELLM_MASTER_KEY not found (env or deploy/compose/.env)");
  return m[1]!.trim();
}

/**
 * Module-singleton state — safe ONLY while this feature has exactly one
 * scenario and no cucumber retry (both true today; cucumber.js sets neither).
 * Convert to a cucumber World before adding scenarios or retry: a second
 * scenario in the same process would reuse a stale engagementId, a dead
 * watchAbort, and accumulated events.
 */
const world = {
  engagementId: `smoke-${Date.now().toString(36)}`,
  gateway: null as LiteLlmModelGateway | null,
  key: null as EngagementKey | null,
  substrate: null as ExecutionSubstrate | null,
  scope: "",
  ref: null as WorkItemRef | null,
  contract: null as HandoffContract | null,
  events: [] as SubstrateEvent[],
  watchAbort: new AbortController(),
  watchDone: null as Promise<void> | null,
  branch: "",
  sha: "",
};

Given("the Tier 1 stack is healthy", async () => {
  const health = await (await fetch(`${MULTICA_URL}/healthz`)).json();
  assert.equal(health.status, "ok", "multica backend healthy");
  const alive = await fetch(`${GATEWAY_URL}/health/liveliness`);
  assert.ok(alive.ok, "litellm gateway alive");
});

Given("a per-engagement virtual key with a 50-cent budget", async () => {
  world.gateway = new LiteLlmModelGateway({ baseUrl: GATEWAY_URL, masterKey: masterKey() });
  world.key = await world.gateway.mintKey(world.engagementId, 50);
  assert.equal(world.key.budgetCents, 50);
});

When("the conductor dispatches the engagement through the substrate port", async () => {
  // the smoke agent's model traffic authenticates with THIS engagement's key
  // (per-agent custom_env — the P11 hook, proven for OpenCode 2026-07-31)
  // cheap tier, but capable enough to actually clone/edit/commit/push:
  // gemini-flash-lite "completes" without doing the work (observed live);
  // deepseek-v3-2 is the cheapest model that reliably executes the flow
  const live = await bootstrapLiveEnv({
    name: "smoke-worker",
    model: process.env.GUILD_SMOKE_MODEL ?? "litellm/or-deepseek-v3-2",
    customEnv: { GUILD_DAEMON_VIRTUAL_KEY: world.key!.key },
  });
  world.scope = live.workspaceId;
  world.substrate = createMulticaSubstrate(
    { baseUrl: live.baseUrl, token: live.token, workspaceId: live.workspaceId },
    {
      projectScope: live.workspaceId,
      roleAgents: { implementer: { agentId: live.agentId, agentName: live.agentName } },
      selfMemberId: live.memberId,
      // M1 smoke runs a single live identity (the daemon claim→push flow, pre-D11
      // governance gates), so there is no distinct operator member to allowlist
      operatorMemberIds: [],
    },
  );

  const marker = `hello guild ${world.engagementId}`;
  world.contract = {
    contractId: `contract-${world.engagementId}`,
    version: 1,
    authoredBy: "conductor",
    gherkin: [
      "Feature: Greeting delivery",
      "  Scenario: the greeting file is delivered",
      "    Given the engagement branch is checked out at the reported commit",
      `    Then GREETING.md contains "${marker}"`,
    ].join("\n"),
    checks: [
      { kind: "artifact", path: "GREETING.md", mustContain: marker },
      { kind: "command", run: `grep -q '${marker}' GREETING.md`, expectExitCode: 0, timeoutSeconds: 30 },
    ],
  };

  // watch first, then create — no event may be missed between the two
  world.watchDone = (async () => {
    for await (const ev of world.substrate!.watch(world.scope, { signal: world.watchAbort.signal })) {
      world.events.push(ev);
    }
  })().catch(() => undefined);

  world.ref = await world.substrate.createWorkItem({
    engagementId: world.engagementId,
    role: "implementer",
    title: `smoke: greeting engagement ${world.engagementId}`,
    brief: {
      roleContext: "You are the implementation engineer for a one-file engagement.",
      instructions: [
        `Your working directory contains a checkout of the ${SCRATCH_REPO.split(":").pop()} repository. Do exactly this:`,
        ``,
        `1. Write the file GREETING.md at the repository root so its content is exactly this one line: ${marker}`,
        `2. Run: git add GREETING.md`,
        `3. Commit with message "smoke ${world.engagementId}"`,
        `4. Push your current branch to origin.`,
        ``,
        `Do not stop after describing the steps — execute them.`,
      ].join("\n"),
      contract: world.contract,
      priorDecisions: [],
      artifactRefs: [],
      constraints: ["Touch only GREETING.md."],
    },
  });
  assert.ok(world.ref.externalId, "work item created via the port");
  // dispatch-saga idempotency in vivo
  assert.deepEqual(await world.substrate.findWorkItem(world.engagementId), world.ref);
});

Then("the agent completes the work item", async () => {
  const deadline = Date.now() + 6 * 60 * 1000;
  for (;;) {
    const snap = await world.substrate!.getWorkItem(world.ref!);
    if (snap.status === "done") {
      assert.ok(snap.report, "work report present");
      assert.match(snap.report!.branchHint ?? "", /^agent\//);
      world.branch = snap.report!.branchHint!;
      return;
    }
    assert.ok(
      !["failed", "cancelled"].includes(snap.status),
      `work item ended ${snap.status} (native: ${snap.nativeStatus}) — ${snap.failure?.detail ?? ""}`,
    );
    assert.ok(Date.now() < deadline, `timeout waiting for completion (last: ${snap.nativeStatus})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
});

Then("status events for the work item arrived over the watch stream", async () => {
  // flush, then cancel via the signal — the port contract for parked streams
  await new Promise((r) => setTimeout(r, 3000));
  world.watchAbort.abort();
  await world.watchDone;
  const statuses = world.events.filter(
    (ev) => ev.kind === "status" && ev.item.externalId === world.ref!.externalId,
  );
  assert.ok(statuses.length > 0, `status events observed (got ${world.events.length} events total)`);
});

Then("the engagement branch lands in the scratch repository", async () => {
  // the ONE branch dereference, at report time: branch hint → pinned SHA (D6)
  const { stdout } = await exec("git", ["ls-remote", SCRATCH_REPO, `refs/heads/${world.branch}`], {
    timeout: 60_000,
  });
  world.sha = stdout.trim().split(/\s/)[0] ?? "";
  assert.match(world.sha, /^[0-9a-f]{40}$/, `branch ${world.branch} resolves to a commit`);
});

Then("the handoff contract validates against the pinned commit", async () => {
  const workRoot = join(repoRoot, ".cache", "validator");
  mkdirSync(workRoot, { recursive: true });
  const validator = createContractValidator({ workRoot, image: "alpine:3.22" });
  const verdict = await validator.validate({
    engagementId: world.engagementId,
    contract: world.contract!,
    repoUrl: SCRATCH_REPO,
    commitSha: world.sha,
  });
  assert.equal(
    verdict.outcome,
    "passed",
    `contract verdict: ${verdict.outcome} — ${verdict.results.map((r) => `${r.outcome}: ${r.detail}`).join("; ")}`,
  );
});

Then("the spend is attributed to the engagement's virtual key", async () => {
  // gateway spend writes batch (~60s, M1a P10) — poll with evidence-based patience
  const deadline = Date.now() + 150_000;
  for (;;) {
    const spend = await world.gateway!.getSpend(world.engagementId);
    assert.ok(spend, "engagement key exists during the run");
    if (spend.spentCents > 0) {
      assert.equal(spend.budgetCents, 50);
      return;
    }
    assert.ok(Date.now() < deadline, "spend never landed on the engagement key");
    await new Promise((r) => setTimeout(r, 10_000));
  }
});

Then("the engagement terminates cleanly", async () => {
  // termination protocol: revoke the key, then cancel (idempotent on terminal) and close
  await world.gateway!.revokeKey(world.engagementId);
  await world.substrate!.cancel(world.ref!, "operator");
  await world.substrate!.close(world.ref!);
});
