/**
 * Driven port for provisioning identities and role agents on the execution
 * substrate's control plane (D15 three-identity partition, D16 starter team).
 * Owned by the Governance context; `guild init` wires it to the substrate
 * package's provisioning adapter. Base URL and auth flow are the adapter's
 * business — the use case sees identities and bindings only.
 */

export interface MemberIdentity {
  token: string;
  memberId: string;
}

export interface AgentBinding {
  agentId: string;
  agentName: string;
}

export interface TeamProvisioner {
  /** mint (or revalidate) a member identity, cached under cacheName across runs */
  acquireMemberToken(email: string, cacheName: string): Promise<MemberIdentity>;
  ensureWorkspaceMember(
    ownerToken: string,
    workspaceId: string,
    member: { token: string; email: string; role: "member" | "admin" },
  ): Promise<void>;
  /** suppress the substrate's stock first-login onboarding (#16) */
  markOnboarded(token: string): Promise<void>;
  ensureAgent(
    token: string,
    workspaceId: string,
    spec: { name: string; model: string },
  ): Promise<AgentBinding>;
}
