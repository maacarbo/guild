/**
 * `guild kill` — the emergency stop (D11 CLI scope). Locks dispatch FIRST
 * (nothing new can spend even if a later step fails), then cancels every
 * spending engagement — substrate cancel kills the agent process (P4/P10)
 * and revokes its key. Recovery is raise-the-cap-and-restart (D12) —
 * deliberate, never automatic.
 *
 * Deliberately needs NO validator and NO filesystem: a kill switch that can
 * crash on a permission error before locking is not a kill switch (M2b
 * verify finding).
 */

import { createMulticaSubstrate } from "@guild/substrate-multica";
import { Conductor } from "../application/conductor.js";
import { GitSourceControl } from "../adapters/git-source-control.js";
import { LiteLlmModelGateway } from "../adapters/litellm-gateway.js";
import { PgGovernanceStore } from "../adapters/pg-governance-store.js";
import { redactUrlCredentials } from "../domain/redact.js";
import { readEnv } from "./env.js";

const env = readEnv([
  { name: "GUILD_MULTICA_URL", source: "Multica backend URL" },
  { name: "GUILD_MULTICA_TOKEN", source: "the conductor member's PAT" },
  { name: "GUILD_WORKSPACE_ID", source: "the project workspace" },
  { name: "GUILD_ROLE_AGENTS", source: "role→agent JSON (guild-init printed it)" },
  { name: "GUILD_GATEWAY_URL", source: "LiteLLM base URL" },
  { name: "LITELLM_MASTER_KEY", source: "gateway master key" },
  { name: "GUILD_POSTGRES_URL", source: "governance DB connection string" },
]);

async function main(): Promise<void> {
  const me = await fetch(`${env.GUILD_MULTICA_URL}/api/me`, {
    headers: { authorization: `Bearer ${env.GUILD_MULTICA_TOKEN}` },
  });
  const selfMemberId = me.ok ? ((await me.json()) as { id: string }).id : "";
  const store = await PgGovernanceStore.connect(env.GUILD_POSTGRES_URL);
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
      // the kill path never validates anything — a stub keeps the wiring honest
      validator: {
        validate: () => Promise.reject(new Error("guild-kill never validates")),
      },
      source: new GitSourceControl(),
      store,
    },
    {
      projectScope: env.GUILD_WORKSPACE_ID,
      repoUrl: "unused://guild-kill",
      targetBranch: "main",
      defaultPlanBudgetCents: 0,
    },
  );
  await conductor.emergencyStop();
  const lock = await store.getDispatchLock();
  console.log(`KILL: dispatch locked (${lock?.reason}). In-flight work cancelled; keys revoked.`);
  console.log("To resume: restore/raise the project caps in deploy/compose/.env and restart the conductor.");
  await store.close();
}

main().catch((e) => {
  console.error(redactUrlCredentials(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
