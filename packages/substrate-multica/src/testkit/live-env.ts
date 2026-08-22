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
  acquireMemberToken,
  acquireTokenAt,
  api,
  ensureAgent,
  repoRoot,
  RUNTIME_PREFIX,
  type AgentSpec,
} from "../adapters/multica-provisioning.js";
import { newestOnlineRuntime } from "../domain/runtime-selection.js";

export {
  acquireMemberToken,
  ensureAgent,
  ensureWorkspaceMember,
  markOnboarded,
} from "../adapters/multica-provisioning.js";

export interface LiveEnv {
  baseUrl: string;
  token: string;
  /** daemon (runtime-owner) PAT — agent create/move is owner-only since v0.4.26 (MUL-6126) */
  agentLifecycleToken: string;
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
    const online = newestOnlineRuntime(runtimes, RUNTIME_PREFIX);
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

  // v0.4.26 (MUL-6126): agent create/move on a private runtime is owner-only
  // — the harness ensures its agent as the DAEMON member, the runtime owner
  const daemon = await acquireMemberToken(baseUrl, "daemon@guild.local", "guild-daemon-token.json");
  const ensured = await ensureAgent(baseUrl, daemon.token, picked.workspaceId, { ...spec, invocableBy: memberId });

  return {
    baseUrl,
    token,
    agentLifecycleToken: daemon.token,
    workspaceId: picked.workspaceId,
    agentId: ensured.agentId,
    agentName: ensured.agentName,
    memberId,
  };
}
