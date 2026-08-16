/**
 * Provision the conductor/daemon identities and the fixed starter team —
 * the Governance policy behind `guild init` (extracted from the bin per the
 * 2026-08-15 audit, hexagonal-4, so the D15/D16 invariants are testable):
 *
 * - D15 (audit #17 A5d): the daemon runs LLM-generated code and its substrate
 *   credential is agent-reachable — it gets its OWN member identity, distinct
 *   from operator and conductor, so no agent-reachable credential resolves to
 *   an identity Guild attributes as `operator`. The distinctness invariant is
 *   fail-closed: a collapsed partition refuses before any team side effect.
 * - #16: the substrate's stock onboarding is misleading under Guild — every
 *   provisioned identity is pre-marked onboarded, best-effort (a failure
 *   degrades to the documented "skip it all" note, never blocks provisioning).
 * - D16: the starter team is the fixed four roles.
 */

import type { AgentBinding, MemberIdentity, TeamProvisioner } from "../ports/team-provisioner.js";

/** the D16 four-role starter team */
export const STARTER_ROLES = ["analyst", "architect", "implementer", "tester"] as const;

export class IdentityCollapseError extends Error {
  constructor(ids: Record<string, string>) {
    super(`identities are not distinct (operator/conductor/daemon): ${JSON.stringify(ids)}`);
    this.name = "IdentityCollapseError";
  }
}

export interface ProvisionTeamInput {
  workspaceId: string;
  operatorEmail: string;
  agentModel: string;
  roles: readonly string[];
}

export interface ProvisionedTeam {
  operator: MemberIdentity;
  conductor: MemberIdentity;
  daemon: MemberIdentity;
  roleAgents: Record<string, AgentBinding>;
  onboarding: { identity: "operator" | "conductor" | "daemon"; ok: boolean; error?: string }[];
}

export async function provisionTeam(port: TeamProvisioner, input: ProvisionTeamInput): Promise<ProvisionedTeam> {
  const operator = await port.acquireMemberToken(input.operatorEmail, "guild-operator-token.json");
  const conductor = await port.acquireMemberToken("conductor@guild.local", "guild-conductor-token.json");
  await port.ensureWorkspaceMember(operator.token, input.workspaceId, {
    token: conductor.token,
    email: "conductor@guild.local",
    role: "admin",
  });
  const daemon = await port.acquireMemberToken("daemon@guild.local", "guild-daemon-token.json");
  await port.ensureWorkspaceMember(operator.token, input.workspaceId, {
    token: daemon.token,
    email: "daemon@guild.local",
    role: "admin",
  });

  const ids = { operator: operator.memberId, conductor: conductor.memberId, daemon: daemon.memberId };
  if (new Set(Object.values(ids)).size !== 3) throw new IdentityCollapseError(ids);

  const onboarding: ProvisionedTeam["onboarding"] = [];
  for (const [identity, token] of [
    ["operator", operator.token],
    ["conductor", conductor.token],
    ["daemon", daemon.token],
  ] as const) {
    try {
      await port.markOnboarded(token);
      onboarding.push({ identity, ok: true });
    } catch (e) {
      onboarding.push({ identity, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const roleAgents: Record<string, AgentBinding> = {};
  for (const role of input.roles) {
    roleAgents[role] = await port.ensureAgent(conductor.token, input.workspaceId, {
      name: `guild-${role}`,
      model: input.agentModel,
    });
  }

  return { operator, conductor, daemon, roleAgents, onboarding };
}
