/**
 * Live-stack wiring for adapter integration tests and the smoke entrypoint:
 * bootstraps credentials against the Tier 1 compose stack with zero manual
 * steps (dev-mode scripted auth, M1a P2), and provisions the test agent.
 *
 * Idempotent by design (the smoke bar: twice-green without reset):
 * - auth: send-code → verify-code (fixed dev code from deploy/compose/.env) →
 *   JWT → fresh PAT (PATs accumulate on the dev stack; harmless)
 * - agent: ensured by name, model pinned to the CHEAP tier (operator rule),
 *   and rebound to the currently-online runtime row every run — container
 *   recreates orphan agents on dead rows (P9b), so rebinding IS the repair.
 *
 * Never logs secret values.
 *
 * Known limitation (accepted for M1b): agent ensure/rebind is check-then-act
 * and the PAT cache write is not cross-process atomic — safe while live runs
 * are single-process (`pnpm test:live` / `pnpm smoke`); revisit before any
 * concurrent live-test execution.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LiveEnv {
  baseUrl: string;
  token: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
}

const AGENT_NAME = "guild-conf";
const AGENT_MODEL = "litellm/or-gemini-flash-lite";
/** D9: OpenCode is the default CLI — its runtime rows are named "Opencode (…)" */
const RUNTIME_PREFIX = "Opencode";

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

function devVerificationCode(): string {
  if (process.env.MULTICA_DEV_VERIFICATION_CODE) return process.env.MULTICA_DEV_VERIFICATION_CODE;
  const envFile = readFileSync(join(repoRoot(), "deploy", "compose", ".env"), "utf8");
  const m = /^MULTICA_DEV_VERIFICATION_CODE=(.+)$/m.exec(envFile);
  if (!m) throw new Error("MULTICA_DEV_VERIFICATION_CODE not found (env or deploy/compose/.env)");
  return m[1]!.trim();
}

async function api<T>(
  baseUrl: string,
  method: string,
  path: string,
  opts: { token?: string; workspaceId?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.workspaceId ? { "x-workspace-id": opts.workspaceId } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * PAT acquisition, idempotent across back-to-back runs (the twice-green bar):
 * env override → cached PAT revalidated via /api/me → dev-code auth. send-code
 * has a request cooldown (verified live 2026-07-31: 429 "please wait before
 * requesting another code"), so we try verify-code against a possibly-still-
 * valid code row first, and wait out the cooldown only as a last resort.
 */
async function acquireToken(baseUrl: string, email: string): Promise<string> {
  if (process.env.GUILD_MULTICA_TOKEN) return process.env.GUILD_MULTICA_TOKEN;

  const cachePath = join(repoRoot(), ".cache", "guild-live-token.json");
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { baseUrl: string; token: string };
    if (cached.baseUrl === baseUrl && cached.token) {
      const me = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${cached.token}` } });
      if (me.ok) return cached.token;
    }
  } catch {
    // no cache yet — fall through to the auth flow
  }

  const code = devVerificationCode();
  const tryVerify = () =>
    api<{ token: string }>(baseUrl, "POST", "/auth/verify-code", { body: { email, code } }).then(
      (r) => r.token,
      () => null,
    );

  let jwt = await tryVerify();
  if (!jwt) {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const res = await fetch(`${baseUrl}/auth/send-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) break;
      if (res.status !== 429 || Date.now() > deadline) {
        throw new Error(`send-code → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      await sleep(5000);
    }
    jwt = await tryVerify();
    if (!jwt) throw new Error("verify-code failed after a fresh send-code — check MULTICA_DEV_VERIFICATION_CODE");
  }

  const { token } = await api<{ token: string }>(baseUrl, "POST", "/api/tokens", {
    token: jwt,
    body: { name: `guild-live-${new Date().toISOString().slice(0, 19)}` },
  });
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ baseUrl, token }), { mode: 0o600 });
  return token;
}

export async function bootstrapLiveEnv(): Promise<LiveEnv> {
  const baseUrl = process.env.GUILD_MULTICA_URL ?? "http://127.0.0.1:8080";
  const email = process.env.GUILD_MULTICA_EMAIL ?? "operator@guild.local";
  const token = await acquireToken(baseUrl, email);

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

  // ensure + rebind the cheap-tier test agent (rebind = the P9b repair, idempotent)
  const agents = await api<Array<{ id: string; name: string; runtime_id: string; model: string }>>(
    baseUrl,
    "GET",
    "/api/agents",
    { token, workspaceId: picked.workspaceId },
  );
  let agent = agents.find((a) => a.name === AGENT_NAME);
  if (!agent) {
    agent = await api(baseUrl, "POST", "/api/agents", {
      token,
      workspaceId: picked.workspaceId,
      body: { name: AGENT_NAME, model: AGENT_MODEL, runtime_id: picked.runtimeId },
    });
  } else if (agent.runtime_id !== picked.runtimeId || agent.model !== AGENT_MODEL) {
    await api(baseUrl, "PUT", `/api/agents/${agent.id}`, {
      token,
      workspaceId: picked.workspaceId,
      body: { runtime_id: picked.runtimeId, model: AGENT_MODEL },
    });
  }

  return {
    baseUrl,
    token,
    workspaceId: picked.workspaceId,
    agentId: agent!.id,
    agentName: AGENT_NAME,
  };
}
