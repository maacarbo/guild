import { describe, expect, it } from "vitest";
import type { AgentBinding, MemberIdentity, TeamProvisioner } from "../ports/team-provisioner.js";
import { IdentityCollapseError, provisionTeam, STARTER_ROLES } from "./provision-team.js";

class FakeProvisioner implements TeamProvisioner {
  tokenCalls: { email: string; cacheName: string }[] = [];
  memberCalls: { ownerToken: string; workspaceId: string; email: string; role: string }[] = [];
  onboardedTokens: string[] = [];
  agentCalls: { token: string; workspaceId: string; name: string; model: string }[] = [];
  /** email → minted identity; a shared identity models a collapsed partition */
  identities = new Map<string, MemberIdentity>();
  /** tokens whose onboarding pre-mark fails (the stock-UI route is flaky, #16) */
  onboardFailures = new Set<string>();

  async acquireMemberToken(email: string, cacheName: string): Promise<MemberIdentity> {
    this.tokenCalls.push({ email, cacheName });
    const minted = this.identities.get(email) ?? { token: `tok-${email}`, memberId: `mid-${email}` };
    return minted;
  }

  async ensureWorkspaceMember(
    ownerToken: string,
    workspaceId: string,
    member: { token: string; email: string; role: "member" | "admin" },
  ): Promise<void> {
    this.memberCalls.push({ ownerToken, workspaceId, email: member.email, role: member.role });
  }

  async markOnboarded(token: string): Promise<void> {
    if (this.onboardFailures.has(token)) throw new Error("onboarding route 500");
    this.onboardedTokens.push(token);
  }

  async ensureAgent(
    token: string,
    workspaceId: string,
    spec: { name: string; model: string },
  ): Promise<AgentBinding> {
    this.agentCalls.push({ token, workspaceId, name: spec.name, model: spec.model });
    return { agentId: `agent-${spec.name}`, agentName: spec.name };
  }
}

const input = {
  workspaceId: "ws-1",
  operatorEmail: "op@example.com",
  agentModel: "litellm/test-model",
  roles: STARTER_ROLES,
};

describe("provisionTeam (D15 identity partition + D16 starter team)", () => {
  it("mints three distinct identities and joins conductor and daemon to the workspace as admin", async () => {
    const port = new FakeProvisioner();
    const team = await provisionTeam(port, input);

    expect(port.tokenCalls).toEqual([
      { email: "op@example.com", cacheName: "guild-operator-token.json" },
      { email: "conductor@guild.local", cacheName: "guild-conductor-token.json" },
      { email: "daemon@guild.local", cacheName: "guild-daemon-token.json" },
    ]);
    expect(port.memberCalls).toEqual([
      { ownerToken: team.operator.token, workspaceId: "ws-1", email: "conductor@guild.local", role: "admin" },
      { ownerToken: team.operator.token, workspaceId: "ws-1", email: "daemon@guild.local", role: "admin" },
    ]);
    expect(new Set([team.operator.memberId, team.conductor.memberId, team.daemon.memberId]).size).toBe(3);
  });

  it("ensures one agent per requested role, named guild-<role>, under the conductor identity", async () => {
    const port = new FakeProvisioner();
    const team = await provisionTeam(port, input);

    expect(port.agentCalls).toEqual(
      STARTER_ROLES.map((role) => ({
        token: team.conductor.token,
        workspaceId: "ws-1",
        name: `guild-${role}`,
        model: "litellm/test-model",
      })),
    );
    expect(Object.keys(team.roleAgents)).toEqual([...STARTER_ROLES]);
    expect(team.roleAgents.analyst).toEqual({ agentId: "agent-guild-analyst", agentName: "guild-analyst" });
  });

  it("pre-marks every identity onboarded best-effort — a failure is recorded, never thrown (#16)", async () => {
    const port = new FakeProvisioner();
    port.onboardFailures.add("tok-daemon@guild.local");
    const team = await provisionTeam(port, input);

    expect(team.onboarding).toEqual([
      { identity: "operator", ok: true },
      { identity: "conductor", ok: true },
      { identity: "daemon", ok: false, error: "onboarding route 500" },
    ]);
    // provisioning continued past the failure — the team still exists
    expect(port.agentCalls.length).toBe(STARTER_ROLES.length);
  });

  it("refuses a collapsed identity partition before any team side effect (D15 fail-closed)", async () => {
    const port = new FakeProvisioner();
    const shared = { token: "tok-shared", memberId: "mid-shared" };
    port.identities.set("conductor@guild.local", shared);
    port.identities.set("daemon@guild.local", shared);

    await expect(provisionTeam(port, input)).rejects.toThrow(IdentityCollapseError);
    expect(port.memberCalls).toEqual([]);
    expect(port.onboardedTokens).toEqual([]);
    expect(port.agentCalls).toEqual([]);
  });

  it("the starter team is the fixed D16 four", () => {
    expect(STARTER_ROLES).toEqual(["analyst", "architect", "implementer", "tester"]);
  });
});
