/**
 * The conductor as a long-running service (M2b ship gate: Tier 1 compose
 * service). Wires the hexagon from env, reconciles on start and on every
 * watch-stream (re)connect (reads are the truth path), sweeps the budget
 * watchdog on an interval, and stops cleanly on SIGTERM/SIGINT.
 */

import { mkdirSync } from "node:fs";
import { createMulticaSubstrate } from "@guild/substrate-multica";
import { Conductor } from "../application/conductor.js";
import { GitSourceControl } from "../adapters/git-source-control.js";
import { LiteLlmModelGateway } from "../adapters/litellm-gateway.js";
import { PgGovernanceStore } from "../adapters/pg-governance-store.js";
import { createContractValidator } from "../index.js";
import { intEnv, readEnv } from "./env.js";

const env = readEnv([
  { name: "GUILD_MULTICA_URL", source: "compose service URL, e.g. http://multica-backend:8080" },
  { name: "GUILD_MULTICA_TOKEN", source: "the CONDUCTOR member's PAT — guild-init prints it" },
  { name: "GUILD_WORKSPACE_ID", source: "the project workspace — guild-init prints it" },
  { name: "GUILD_ROLE_AGENTS", source: "role→agent JSON — guild-init prints it" },
  { name: "GUILD_GATEWAY_URL", source: "LiteLLM base URL, e.g. http://litellm:4000" },
  { name: "LITELLM_MASTER_KEY", source: "gateway master key (normative secret, deploy/compose/.env)" },
  { name: "GUILD_POSTGRES_URL", source: "governance DB connection string" },
  { name: "GUILD_REPO_URL", source: "product repository (HTTPS with the scoped git PAT embedded)" },
  { name: "GUILD_TARGET_BRANCH", source: "acceptance fast-forward target", fallback: "main" },
  { name: "GUILD_PLAN_BUDGET_CENTS", source: "default plan budget when the idea names none", fallback: "100" },
  { name: "GUILD_PROJECT_SOFT_CAP_CENTS", source: "project soft cap (watchdog warn)", optional: true },
  { name: "GUILD_PROJECT_HARD_CAP_CENTS", source: "project hard cap (watchdog halt)", optional: true },
  { name: "GUILD_VALIDATOR_IMAGE", source: "sandbox image for contract checks", fallback: "node:22-alpine" },
  { name: "GUILD_VALIDATOR_WORK", source: "clone root for validation", fallback: "/var/guild/validator-work" },
  { name: "GUILD_VALIDATOR_VOLUME", source: "named volume backing the work root (containerized mode)", optional: true },
  { name: "GUILD_SWEEP_SECONDS", source: "watchdog cadence", fallback: "30" },
  { name: "GUILD_RECONCILE_SECONDS", source: "reconciliation cadence", fallback: "300" },
]);

const soft = env.GUILD_PROJECT_SOFT_CAP_CENTS ? intEnv(env, "GUILD_PROJECT_SOFT_CAP_CENTS") : undefined;
const hard = env.GUILD_PROJECT_HARD_CAP_CENTS ? intEnv(env, "GUILD_PROJECT_HARD_CAP_CENTS") : undefined;
if ((soft === undefined) !== (hard === undefined)) {
  console.error("Set BOTH GUILD_PROJECT_SOFT_CAP_CENTS and GUILD_PROJECT_HARD_CAP_CENTS, or neither.");
  process.exit(1);
}

async function main(): Promise<void> {
  const me = await fetch(`${env.GUILD_MULTICA_URL}/api/me`, {
    headers: { authorization: `Bearer ${env.GUILD_MULTICA_TOKEN}` },
  });
  if (!me.ok) {
    console.error(`GUILD_MULTICA_TOKEN rejected by ${env.GUILD_MULTICA_URL}/api/me → ${me.status}`);
    process.exit(1);
  }
  const selfMemberId = ((await me.json()) as { id: string }).id;

  const substrate = createMulticaSubstrate(
    { baseUrl: env.GUILD_MULTICA_URL, token: env.GUILD_MULTICA_TOKEN, workspaceId: env.GUILD_WORKSPACE_ID },
    {
      projectScope: env.GUILD_WORKSPACE_ID,
      roleAgents: JSON.parse(env.GUILD_ROLE_AGENTS) as Record<string, { agentId: string; agentName: string }>,
      selfMemberId,
    },
  );
  const store = await PgGovernanceStore.connect(env.GUILD_POSTGRES_URL);
  mkdirSync(env.GUILD_VALIDATOR_WORK, { recursive: true });
  const conductor = new Conductor(
    {
      substrate,
      gateway: new LiteLlmModelGateway({ baseUrl: env.GUILD_GATEWAY_URL, masterKey: env.LITELLM_MASTER_KEY }),
      validator: createContractValidator({
        workRoot: env.GUILD_VALIDATOR_WORK,
        image: env.GUILD_VALIDATOR_IMAGE,
        ...(env.GUILD_VALIDATOR_VOLUME ? { workVolumeName: env.GUILD_VALIDATOR_VOLUME } : {}),
      }),
      source: new GitSourceControl(),
      store,
    },
    {
      projectScope: env.GUILD_WORKSPACE_ID,
      repoUrl: env.GUILD_REPO_URL,
      targetBranch: env.GUILD_TARGET_BRANCH,
      defaultPlanBudgetCents: intEnv(env, "GUILD_PLAN_BUDGET_CENTS"),
      ...(soft !== undefined && hard !== undefined
        ? { projectBudget: { projectId: env.GUILD_WORKSPACE_ID, softCapCents: soft, hardCapCents: hard } }
        : {}),
    },
  );

  const abort = new AbortController();
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} — stopping`);
    abort.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const sweeper = setInterval(() => {
    conductor.sweep().catch((e) => console.error(`sweep failed (retried next tick): ${e?.message ?? e}`));
  }, intEnv(env, "GUILD_SWEEP_SECONDS") * 1000);
  const reconciler = setInterval(() => {
    conductor.reconcile().catch((e) => console.error(`reconcile failed (retried next tick): ${e?.message ?? e}`));
  }, intEnv(env, "GUILD_RECONCILE_SECONDS") * 1000);

  console.log(`guild-conductor: workspace ${env.GUILD_WORKSPACE_ID}, member ${selfMemberId}`);
  try {
    while (!stopping) {
      // reads first, on start and after every stream drop — a missed event
      // must never strand an engagement (conductor runtime semantics)
      await conductor.reconcile().catch((e) => console.error(`reconcile failed: ${e?.message ?? e}`));
      try {
        await conductor.run({ signal: abort.signal });
      } catch (e) {
        console.error(`watch stream error: ${(e as Error)?.message ?? e}`);
      }
      if (!stopping) await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    clearInterval(sweeper);
    clearInterval(reconciler);
    await store.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
