/**
 * `guild init` — one-shot bootstrap (D11 CLI scope: init, doctor, demo,
 * kill-switch — nothing else). Provisions the conductor identity and the
 * fixed four-role starter team on the self-hosted stack, then PRINTS the
 * conductor env values for deploy/compose/.env. Values go to the operator's
 * terminal only — never into tracked files.
 *
 * The provisioning policy (D15 identity partition, #16 onboarding pre-mark,
 * D16 starter team) lives in application/provision-team.ts; this bin is
 * env-read → wire → call → print. The wiring uses the dev-code auth flow the
 * Tier 1 stack ships with (MULTICA_DEV_VERIFICATION_CODE) via the substrate
 * package's provisioning adapter — one bootstrap implementation deliberately
 * shared with the live test harness, homed in the adapter layer so
 * production code never imports test support (D7).
 */

import { acquireMemberToken, ensureAgent, ensureWorkspaceMember, markOnboarded } from "@guild/substrate-multica";
import { IdentityCollapseError, provisionTeam, STARTER_ROLES } from "../application/provision-team.js";
import type { TeamProvisioner } from "../ports/team-provisioner.js";
import { readEnv } from "./env.js";

const env = readEnv([
  { name: "GUILD_MULTICA_URL", source: "Multica backend URL", fallback: "http://127.0.0.1:8080" },
  { name: "GUILD_OPERATOR_EMAIL", source: "the operator's login email", fallback: "operator@guild.local" },
  { name: "GUILD_WORKSPACE_ID", source: "the project workspace id (create it in the Multica UI first)" },
  { name: "GUILD_AGENT_MODEL", source: "role-agent model (cheap tier default)", fallback: "litellm/or-deepseek-v3-2" },
]);

const baseUrl = env.GUILD_MULTICA_URL;
const provisioner: TeamProvisioner = {
  acquireMemberToken: (email, cacheName) => acquireMemberToken(baseUrl, email, cacheName),
  ensureWorkspaceMember: (ownerToken, workspaceId, member) =>
    ensureWorkspaceMember(baseUrl, ownerToken, workspaceId, member),
  markOnboarded: (token) => markOnboarded(baseUrl, token),
  ensureAgent: (token, workspaceId, spec) => ensureAgent(baseUrl, token, workspaceId, spec),
};

async function main(): Promise<void> {
  const team = await provisionTeam(provisioner, {
    workspaceId: env.GUILD_WORKSPACE_ID,
    operatorEmail: env.GUILD_OPERATOR_EMAIL,
    agentModel: env.GUILD_AGENT_MODEL,
    roles: STARTER_ROLES,
  });

  for (const o of team.onboarding) {
    if (o.ok) console.error(`  ✓ ${o.identity} onboarding pre-marked`);
    else console.error(`  ! could not pre-mark ${o.identity} onboarded (non-fatal): ${o.error}`);
  }
  for (const role of STARTER_ROLES) {
    console.error(`  ✓ agent guild-${role} (${env.GUILD_AGENT_MODEL})`);
  }

  console.error("\nAdd these to deploy/compose/.env:\n");
  console.error("  # conductor section");
  console.log(`GUILD_MULTICA_TOKEN=${team.conductor.token}`);
  console.log(`GUILD_WORKSPACE_ID=${env.GUILD_WORKSPACE_ID}`);
  console.log(`GUILD_ROLE_AGENTS=${JSON.stringify(team.roleAgents)}`);
  // the conductor attributes ONLY these member ids as the operator (D15 allowlist)
  console.log(`GUILD_OPERATOR_MEMBER_IDS=${team.operator.memberId}`);
  // asserted at conductor startup to be absent from the allowlist (A5d guard)
  console.log(`GUILD_DAEMON_MEMBER_ID=${team.daemon.memberId}`);
  console.error("\n  # daemon section (was hand-minted from the operator account — now init-minted, a NON-governance identity)");
  console.log(`MULTICA_DAEMON_TOKEN=${team.daemon.token}`);
}

main().catch((e) => {
  // the D15 refusal is an operator diagnostic, not a crash — no stack trace
  if (e instanceof IdentityCollapseError) console.error(`\n✗ ${e.message} — aborting`);
  else console.error(e);
  process.exit(1);
});
