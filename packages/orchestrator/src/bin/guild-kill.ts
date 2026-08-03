/**
 * `guild kill` — the emergency stop (D11 CLI scope). Cancels every spending
 * engagement (substrate cancel kills the agent process — P10), revokes their
 * keys, and locks dispatch. Mechanically: one watchdog sweep under a
 * zero-cent hard cap, plus an explicit lock when nothing was ever minted.
 * Recovery is raise-the-cap-and-restart (D12) — deliberate, never automatic.
 */

import { mkdirSync } from "node:fs";
import { createMulticaSubstrate } from "@guild/substrate-multica";
import { Conductor } from "../application/conductor.js";
import { GitSourceControl } from "../adapters/git-source-control.js";
import { LiteLlmModelGateway } from "../adapters/litellm-gateway.js";
import { PgGovernanceStore } from "../adapters/pg-governance-store.js";
import { createContractValidator } from "../index.js";
import { readEnv } from "./env.js";

const env = readEnv([
  { name: "GUILD_MULTICA_URL", source: "Multica backend URL" },
  { name: "GUILD_MULTICA_TOKEN", source: "the conductor member's PAT" },
  { name: "GUILD_WORKSPACE_ID", source: "the project workspace" },
  { name: "GUILD_ROLE_AGENTS", source: "role→agent JSON (guild-init printed it)" },
  { name: "GUILD_GATEWAY_URL", source: "LiteLLM base URL" },
  { name: "LITELLM_MASTER_KEY", source: "gateway master key" },
  { name: "GUILD_POSTGRES_URL", source: "governance DB connection string" },
  { name: "GUILD_REPO_URL", source: "product repository" },
  { name: "GUILD_VALIDATOR_WORK", source: "clone root", fallback: "/var/guild/validator-work" },
]);

async function main(): Promise<void> {
  const me = await fetch(`${env.GUILD_MULTICA_URL}/api/me`, {
    headers: { authorization: `Bearer ${env.GUILD_MULTICA_TOKEN}` },
  });
  const selfMemberId = me.ok ? ((await me.json()) as { id: string }).id : "";
  const store = await PgGovernanceStore.connect(env.GUILD_POSTGRES_URL);
  mkdirSync(env.GUILD_VALIDATOR_WORK, { recursive: true });
  const conductor = new Conductor(
    {
      substrate: createMulticaSubstrate(
        { baseUrl: env.GUILD_MULTICA_URL, token: env.GUILD_MULTICA_TOKEN, workspaceId: env.GUILD_WORKSPACE_ID },
        {
          projectScope: env.GUILD_WORKSPACE_ID,
          roleAgents: JSON.parse(env.GUILD_ROLE_AGENTS) as Record<string, { agentId: string; agentName: string }>,
          selfMemberId,
        },
      ),
      gateway: new LiteLlmModelGateway({ baseUrl: env.GUILD_GATEWAY_URL, masterKey: env.LITELLM_MASTER_KEY }),
      validator: createContractValidator({ workRoot: env.GUILD_VALIDATOR_WORK, image: "node:22-alpine" }),
      source: new GitSourceControl(),
      store,
    },
    {
      projectScope: env.GUILD_WORKSPACE_ID,
      repoUrl: env.GUILD_REPO_URL,
      targetBranch: "main",
      defaultPlanBudgetCents: 0,
      projectBudget: { projectId: env.GUILD_WORKSPACE_ID, softCapCents: 0, hardCapCents: 0 },
    },
  );
  await conductor.sweep();
  if (!(await store.getDispatchLock())) {
    await store.setDispatchLock("kill_switch: operator emergency stop", new Date().toISOString());
  }
  const lock = await store.getDispatchLock();
  console.log(`KILL: dispatch locked (${lock?.reason}). In-flight work cancelled; keys revoked.`);
  console.log("To resume: raise/restore the project caps in deploy/compose/.env and restart the conductor.");
  await store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
