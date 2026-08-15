/**
 * Live-stack wiring for adapter integration tests and the smoke entrypoint:
 * bootstraps credentials against the Tier 1 compose stack with zero manual
 * steps (dev-mode scripted auth, M1a P2), and provisions the test agent.
 *
 * The provisioning primitives (auth, membership, agents, onboarding) live in
 * `adapters/multica-provisioning.ts` — shared with `guild init`, re-exported
 * here for the live harness. This module keeps only what is test-specific:
 * the operator-token env override, the test agent's name/model defaults, and
 * the workspace discovery that follows the daemon's runtime registration.
 */

import { join } from "node:path";
import {
  acquireTokenAt,
  api,
  ensureAgent,
  repoRoot,
  RUNTIME_PREFIX,
  type AgentSpec,
} from "../adapters/multica-provisioning.js";

export {
  acquireMemberToken,
  ensureAgent,
  ensureWorkspaceMember,
  markOnboarded,
} from "../adapters/multica-provisioning.js";

export interface LiveEnv {
  baseUrl: string;
  token: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  /** the PAT's own member id — the conductor identity for lane-move attribution (D11/P22) */
  memberId: string;
}

/** the test agent's spec; model defaults to the harness's cheap tier */
export type LiveAgentSpec = Omit<AgentSpec, "model"> & { model?: string };

const AGENT_NAME = "guild-conf";
const AGENT_MODEL = "litellm/or-gemini-flash-lite";

/**
 * PAT for the harness's operator identity, idempotent across back-to-back
 * runs (the twice-green bar): env override → cached PAT → dev-code auth.
 */
async function acquireToken(baseUrl: string, email: string): Promise<string> {
  if (process.env.GUILD_MULTICA_TOKEN) return process.env.GUILD_MULTICA_TOKEN;
  return acquireTokenAt(baseUrl, email, join(repoRoot(), ".cache", "guild-live-token.json"));
}

export async function bootstrapLiveEnv(agentSpec?: LiveAgentSpec): Promise<LiveEnv> {
  const baseUrl = process.env.GUILD_MULTICA_URL ?? "http://127.0.0.1:8080";
  const email = process.env.GUILD_MULTICA_EMAIL ?? "operator@guild.local";
  const spec: AgentSpec = { name: AGENT_NAME, model: AGENT_MODEL, ...agentSpec };
  const token = await acquireToken(baseUrl, email);
  const { id: memberId } = await api<{ id: string }>(baseUrl, "GET", "/api/me", { token });

  // the workspace that has runtime rows is the one the daemon registered into
  const workspaces = await api<Array<{ id: string; name: string }>>(baseUrl, "GET", "/api/workspaces", { token });
  let picked: { workspaceId: string; runtimeId: string } | null = null;
  for (const ws of workspaces) {
    const runtimes = await api<Array<{ id: string; name: string; status: string }>>(
      baseUrl,
      "GET",
      "/api/runtimes",
      { token, workspaceId: ws.id },
    );
    const online = runtimes.find((r) => r.status === "online" && r.name.startsWith(RUNTIME_PREFIX));
    if (online) {
      picked = { workspaceId: ws.id, runtimeId: online.id };
      break;
    }
  }
  if (!picked) {
    throw new Error(
      `no online ${RUNTIME_PREFIX} runtime in any workspace — is the daemon up? (docker compose --profile daemon up -d)`,
    );
  }

  const ensured = await ensureAgent(baseUrl, token, picked.workspaceId, spec);

  return {
    baseUrl,
    token,
    workspaceId: picked.workspaceId,
    agentId: ensured.agentId,
    agentName: ensured.agentName,
    memberId,
  };
}
