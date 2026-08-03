/**
 * `guild init` — one-shot bootstrap (D11 CLI scope: init, doctor, demo,
 * kill-switch — nothing else). Provisions the conductor identity and the
 * fixed four-role starter team on the self-hosted stack, then PRINTS the
 * conductor env values for deploy/compose/.env. Values go to the operator's
 * terminal only — never into tracked files.
 *
 * Uses the dev-code auth flow the Tier 1 stack ships with
 * (MULTICA_DEV_VERIFICATION_CODE) via the substrate testkit — bootstrap
 * tooling shares the test bootstrap, deliberately.
 */

import { acquireMemberToken, ensureAgent, ensureWorkspaceMember } from "@guild/substrate-multica/testkit";
import { readEnv } from "./env.js";

const ROLES = ["analyst", "architect", "implementer", "tester"] as const;

const env = readEnv([
  { name: "GUILD_MULTICA_URL", source: "Multica backend URL", fallback: "http://127.0.0.1:8080" },
  { name: "GUILD_OPERATOR_EMAIL", source: "the operator's login email", fallback: "operator@guild.local" },
  { name: "GUILD_WORKSPACE_ID", source: "the project workspace id (create it in the Multica UI first)" },
  { name: "GUILD_AGENT_MODEL", source: "role-agent model (cheap tier default)", fallback: "litellm/or-deepseek-v3-2" },
]);

async function main(): Promise<void> {
  const operator = await acquireMemberToken(env.GUILD_MULTICA_URL, env.GUILD_OPERATOR_EMAIL, "guild-operator-token.json");
  const conductor = await acquireMemberToken(env.GUILD_MULTICA_URL, "conductor@guild.local", "guild-conductor-token.json");
  await ensureWorkspaceMember(env.GUILD_MULTICA_URL, operator.token, env.GUILD_WORKSPACE_ID, {
    token: conductor.token,
    email: "conductor@guild.local",
    role: "admin",
  });

  const roleAgents: Record<string, { agentId: string; agentName: string }> = {};
  for (const role of ROLES) {
    roleAgents[role] = await ensureAgent(env.GUILD_MULTICA_URL, conductor.token, env.GUILD_WORKSPACE_ID, {
      name: `guild-${role}`,
      model: env.GUILD_AGENT_MODEL,
    });
    console.error(`  ✓ agent guild-${role} (${env.GUILD_AGENT_MODEL})`);
  }

  console.error("\nAdd these to deploy/compose/.env (conductor section):\n");
  console.log(`GUILD_MULTICA_TOKEN=${conductor.token}`);
  console.log(`GUILD_WORKSPACE_ID=${env.GUILD_WORKSPACE_ID}`);
  console.log(`GUILD_ROLE_AGENTS=${JSON.stringify(roleAgents)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
