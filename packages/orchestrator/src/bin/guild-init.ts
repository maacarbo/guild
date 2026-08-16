/**
 * `guild init` — one-shot bootstrap (D11 CLI scope: init, doctor, demo,
 * kill-switch — nothing else). Provisions the conductor identity and the
 * fixed four-role starter team on the self-hosted stack, then PRINTS the
 * conductor env values for deploy/compose/.env. Values go to the operator's
 * terminal only — never into tracked files.
 *
 * Uses the dev-code auth flow the Tier 1 stack ships with
 * (MULTICA_DEV_VERIFICATION_CODE) via the substrate package's provisioning
 * adapter — one bootstrap implementation deliberately shared with the live
 * test harness, homed in the adapter layer so production code never imports
 * test support (D7).
 */

import { acquireMemberToken, ensureAgent, ensureWorkspaceMember, markOnboarded } from "@guild/substrate-multica";
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

  // D15 (audit #17 A5d): the daemon runs LLM-generated code and its Multica
  // credential is agent-reachable. Give it its OWN member identity so no
  // agent-reachable credential resolves to an identity Guild attributes as
  // `operator`. Before this fix MULTICA_DAEMON_TOKEN was minted by hand from the
  // operator's account and resolved to the operator; now init mints it, distinct
  // from operator and conductor. It joins the workspace so its runtime registers
  // there (P30: runtimes are workspace-scoped, owner_id orthogonal).
  const daemon = await acquireMemberToken(env.GUILD_MULTICA_URL, "daemon@guild.local", "guild-daemon-token.json");
  await ensureWorkspaceMember(env.GUILD_MULTICA_URL, operator.token, env.GUILD_WORKSPACE_ID, {
    token: daemon.token,
    email: "daemon@guild.local",
    role: "admin",
  });

  // #16: Multica's stock onboarding is misleading under Guild (the daemon IS
  // the agent connection; init creates the team) — pre-mark every provisioned
  // account onboarded. Best-effort: a failure here degrades to the documented
  // "skip it all" note, never blocks provisioning.
  for (const [name, token] of [
    ["operator", operator.token],
    ["conductor", conductor.token],
    ["daemon", daemon.token],
  ] as const) {
    try {
      await markOnboarded(env.GUILD_MULTICA_URL, token);
      console.error(`  ✓ ${name} onboarding pre-marked`);
    } catch (e) {
      console.error(`  ! could not pre-mark ${name} onboarded (non-fatal): ${e instanceof Error ? e.message : e}`);
    }
  }

  const roleAgents: Record<string, { agentId: string; agentName: string }> = {};
  for (const role of ROLES) {
    roleAgents[role] = await ensureAgent(env.GUILD_MULTICA_URL, conductor.token, env.GUILD_WORKSPACE_ID, {
      name: `guild-${role}`,
      model: env.GUILD_AGENT_MODEL,
    });
    console.error(`  ✓ agent guild-${role} (${env.GUILD_AGENT_MODEL})`);
  }

  // Fail-closed invariant (D15): the three identities MUST be distinct, and the
  // operator allowlist must contain ONLY the operator. If minting ever collapsed
  // two of them, the fix would silently regress — refuse rather than print it.
  const ids = { operator: operator.memberId, conductor: conductor.memberId, daemon: daemon.memberId };
  if (new Set(Object.values(ids)).size !== 3) {
    console.error(`\n✗ identities are not distinct (operator/conductor/daemon): ${JSON.stringify(ids)} — aborting`);
    process.exit(1);
  }

  console.error("\nAdd these to deploy/compose/.env:\n");
  console.error("  # conductor section");
  console.log(`GUILD_MULTICA_TOKEN=${conductor.token}`);
  console.log(`GUILD_WORKSPACE_ID=${env.GUILD_WORKSPACE_ID}`);
  console.log(`GUILD_ROLE_AGENTS=${JSON.stringify(roleAgents)}`);
  // the conductor attributes ONLY these member ids as the operator (D15 allowlist)
  console.log(`GUILD_OPERATOR_MEMBER_IDS=${operator.memberId}`);
  // asserted at conductor startup to be absent from the allowlist (A5d guard)
  console.log(`GUILD_DAEMON_MEMBER_ID=${daemon.memberId}`);
  console.error("\n  # daemon section (was hand-minted from the operator account — now init-minted, a NON-governance identity)");
  console.log(`MULTICA_DAEMON_TOKEN=${daemon.token}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
