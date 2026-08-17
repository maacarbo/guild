/**
 * Provisioning adapter over Multica's REST API: identity minting (dev-code
 * auth), workspace membership, agent ensure/rebind, onboarding pre-mark.
 * One implementation deliberately shared by `guild init` (production
 * bootstrap) and the live-test harness (testkit re-exports it) — moved here
 * from the testkit so production code never imports test support
 * (audit 2026-08-15, D7 dependency rule).
 *
 * Idempotent by design (the smoke bar: twice-green without reset):
 * - auth: send-code → verify-code (fixed dev code from deploy/compose/.env) →
 *   JWT → fresh PAT (PATs accumulate on the dev stack; harmless)
 * - agent: ensured by name and rebound to the currently-online runtime row on
 *   every call — container recreates orphan agents on dead rows (P9b), so
 *   rebinding IS the repair.
 *
 * Never logs secret values.
 *
 * Known limitation (accepted for M1b): agent ensure/rebind is check-then-act
 * and the PAT cache write is not cross-process atomic — safe while callers
 * are single-process (`guild init`, `pnpm test:live`, `pnpm smoke`); revisit
 * before any concurrent execution.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** the agent to provision; the smoke passes its per-engagement key via customEnv */
export interface AgentSpec {
  name: string;
  /** required — every caller pins its tier; no default model route in production code */
  model: string;
  customEnv?: Record<string, string>;
  /**
   * member id allowed to assign work to this agent (v0.4.26 MUL-6126:
   * daemon-created agents are private by default). Applied at CREATE only —
   * permission updates are owner-only and existing agents keep their mode.
   */
  invocableBy?: string;
}

/** D9: OpenCode is the default CLI — its runtime rows are named "Opencode (…)" */
export const RUNTIME_PREFIX = "Opencode";

export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

function devVerificationCode(): string {
  if (process.env.MULTICA_DEV_VERIFICATION_CODE) return process.env.MULTICA_DEV_VERIFICATION_CODE;
  const envFile = readFileSync(join(repoRoot(), "deploy", "compose", ".env"), "utf8");
  const m = /^MULTICA_DEV_VERIFICATION_CODE=(.+)$/m.exec(envFile);
  if (!m) throw new Error("MULTICA_DEV_VERIFICATION_CODE not found (env or deploy/compose/.env)");
  return m[1]!.trim();
}

export async function api<T>(
  baseUrl: string,
  method: string,
  path: string,
  opts: { token?: string; workspaceId?: string; body?: unknown; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const res = await (opts.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.workspaceId ? { "x-workspace-id": opts.workspaceId } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * PAT acquisition against a dev-mode stack, idempotent across back-to-back
 * runs: cached PAT revalidated via /api/me → dev-code auth. send-code has a
 * request cooldown (verified live 2026-07-31: 429 "please wait before
 * requesting another code"), so we try verify-code against a possibly-still-
 * valid code row first, and wait out the cooldown only as a last resort.
 */
export async function acquireTokenAt(
  baseUrl: string,
  email: string,
  cachePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { baseUrl: string; token: string };
    if (cached.baseUrl === baseUrl && cached.token) {
      const me = await fetchImpl(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${cached.token}` } });
      if (me.ok) return cached.token;
    }
  } catch {
    // no cache yet — fall through to the auth flow
  }

  const code = devVerificationCode();
  const tryVerify = () =>
    api<{ token: string }>(baseUrl, "POST", "/auth/verify-code", { body: { email, code }, fetchImpl }).then(
      (r) => r.token,
      () => null,
    );

  let jwt = await tryVerify();
  if (!jwt) {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const res = await fetchImpl(`${baseUrl}/auth/send-code`, {
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
    fetchImpl,
  });
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ baseUrl, token }), { mode: 0o600 });
  return token;
}

/**
 * PAT + member id for an arbitrary dev-stack identity (same dev-code auth and
 * cache discipline as the operator flow). The conductor runs under its own
 * member identity (D11) — this is how `guild init` mints it.
 */
export async function acquireMemberToken(
  baseUrl: string,
  email: string,
  cacheName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string; memberId: string }> {
  const token = await acquireTokenAt(baseUrl, email, join(repoRoot(), ".cache", cacheName), fetchImpl);
  const { id } = await api<{ id: string }>(baseUrl, "GET", "/api/me", { token, fetchImpl });
  return { token, memberId: id };
}

/**
 * Suppress Multica's stock first-login onboarding for a Guild-provisioned
 * account (#16): the daemon container IS the agent connection and `guild init`
 * creates the team, so every onboarding prompt asks for something Guild
 * already does. POST /api/me/onboarding/complete is what the UI's skip path
 * calls and the only route that sets `onboarded_at` (probed live 2026-08-13:
 * the PATCH questionnaire route never does). Idempotent on an already
 * onboarded account.
 */
export async function markOnboarded(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await api(baseUrl, "POST", "/api/me/onboarding/complete", { token, fetchImpl });
}

/**
 * Idempotently make `member` a workspace member with the given role
 * (live-proven 2026-08-02: POST /api/workspaces/{id}/members mints a pending
 * invitation; the invitee accepts via POST /api/invitations/{id}/accept; a
 * role change is remove + re-invite — the member-row PUT is 405).
 * Crash-safe (#11, live-probed 2026-08-03): a duplicate invite 409s
 * ("invitation already pending"), and pending invitations are listable
 * owner-side at GET /api/workspaces/{id}/invitations — a run that died
 * between invite and accept is adopted, never wedged.
 */
export async function ensureWorkspaceMember(
  baseUrl: string,
  ownerToken: string,
  workspaceId: string,
  member: { token: string; email: string; role: "member" | "admin" },
): Promise<void> {
  interface MemberRow {
    id: string;
    email: string;
    role: string;
  }
  interface InvitationRow {
    id: string;
    invitee_email: string;
    status: string;
  }
  const acceptPending = async (): Promise<boolean> => {
    const invitations = await api<InvitationRow[]>(baseUrl, "GET", `/api/workspaces/${workspaceId}/invitations`, {
      token: ownerToken,
      workspaceId,
    });
    const pending = invitations.find((i) => i.invitee_email === member.email && i.status === "pending");
    if (!pending) return false;
    await api(baseUrl, "POST", `/api/invitations/${pending.id}/accept`, { token: member.token });
    return true;
  };

  const members = () =>
    api<MemberRow[]>(baseUrl, "GET", `/api/workspaces/${workspaceId}/members`, {
      token: ownerToken,
      workspaceId,
    });

  let rows = await members();
  let existing = rows.find((r) => r.email === member.email);
  if (existing?.role === member.role) return;

  // a prior run may have crashed between invite and accept — adopt its invite
  if (!existing && (await acceptPending())) {
    rows = await members();
    existing = rows.find((r) => r.email === member.email);
    if (existing?.role === member.role) return;
  }

  if (existing) {
    await api(baseUrl, "DELETE", `/api/workspaces/${workspaceId}/members/${existing.id}`, {
      token: ownerToken,
      workspaceId,
    });
  }
  try {
    const invitation = await api<{ id: string }>(baseUrl, "POST", `/api/workspaces/${workspaceId}/members`, {
      token: ownerToken,
      workspaceId,
      body: { email: member.email, role: member.role },
    });
    await api(baseUrl, "POST", `/api/invitations/${invitation.id}/accept`, { token: member.token });
  } catch (e) {
    // 409 = already pending (raced or crashed earlier) — accept that one
    if (e instanceof Error && e.message.includes("409") && (await acceptPending())) return;
    throw e;
  }
}

/**
 * Ensure + rebind an agent by name in the given workspace (rebind = the P9b
 * repair, idempotent). When a customEnv is given it is re-applied on every
 * call — the smoke rotates the per-engagement key there each time. Works for
 * any member whose role may create agents on the runtime (owner, or admin —
 * live-proven 2026-08-02: plain members are refused on private runtimes).
 */
export async function ensureAgent(
  baseUrl: string,
  token: string,
  workspaceId: string,
  spec: AgentSpec,
): Promise<{ agentId: string; agentName: string }> {
  const runtimes = await api<Array<{ id: string; name: string; status: string }>>(
    baseUrl,
    "GET",
    "/api/runtimes",
    { token, workspaceId },
  );
  const online = runtimes.find((r) => r.status === "online" && r.name.startsWith(RUNTIME_PREFIX));
  if (!online) {
    throw new Error(`no online ${RUNTIME_PREFIX} runtime in workspace ${workspaceId} — is the daemon up?`);
  }
  const model = spec.model;

  const agents = await api<Array<{ id: string; name: string; runtime_id: string; model: string }>>(
    baseUrl,
    "GET",
    "/api/agents",
    { token, workspaceId },
  );
  let agent = agents.find((a) => a.name === spec.name);
  if (!agent) {
    agent = await api(baseUrl, "POST", "/api/agents", {
      token,
      workspaceId,
      body: {
        name: spec.name,
        model,
        runtime_id: online.id,
        ...(spec.customEnv ? { custom_env: spec.customEnv } : {}),
        ...(spec.invocableBy
          ? { permission_mode: "public_to", invocation_targets: [{ target_type: "member", target_id: spec.invocableBy }] }
          : {}),
      },
    });
  } else {
    if (agent.runtime_id !== online.id || agent.model !== model) {
      await api(baseUrl, "PUT", `/api/agents/${agent.id}`, {
        token,
        workspaceId,
        body: { runtime_id: online.id, model },
      });
    }
    if (spec.customEnv) {
      // env updates moved to a dedicated endpoint (v0.4.15: the update PUT
      // rejects custom_env); wholesale replace, member-token auth required
      await api(baseUrl, "PUT", `/api/agents/${agent.id}/env`, {
        token,
        workspaceId,
        body: { custom_env: spec.customEnv },
      });
    }
  }
  return { agentId: agent!.id, agentName: spec.name };
}
