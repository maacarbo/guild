/**
 * Pure translation between Multica vocabulary and the @guild/shared port
 * language — the heart of the anti-corruption layer (D8). No I/O here.
 * Evidence: the status/failure/branch-hint maps come from the M1a capability
 * matrix (P3/P7/P10/P13/P16); the engagement marker and the HTTP fault
 * classification come from the M1b live probes (2026-07-31 — metadata not
 * persisted, PUT-only updates, allow_duplicate 409) plus the closed-set
 * totality requirement. The closed-union policy is normative throughout:
 * unmapped native values surface as "unknown", never as the nearest neighbor.
 */

import type { SubstrateError, WorkItemFailure, WorkItemStatus } from "@guild/shared";

/** M1a P13 state set; dispatched/deferred are pre-execution → queued; waiting_local_directory blocks on the runtime environment */
const TASK_STATE_MAP: Record<string, WorkItemStatus> = {
  queued: "queued",
  dispatched: "queued",
  deferred: "queued",
  running: "running",
  waiting_local_directory: "blocked",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export function statusFromTaskState(native: string): WorkItemStatus {
  return TASK_STATE_MAP[native] ?? "unknown";
}

/** M1a P10: the budget-capped 429 lands as this exact reason, non-retryable */
const CAPACITY_REASON = "agent_error.provider_capacity_or_rate_limit";

export function classifyFailure(nativeReason: string | null | undefined): WorkItemFailure {
  if (!nativeReason) {
    return { category: "unknown", detail: "" };
  }
  if (nativeReason === CAPACITY_REASON) {
    return { category: "provider_capacity_or_budget", detail: nativeReason };
  }
  if (nativeReason.startsWith("agent_error.")) {
    return { category: "agent_error", detail: nativeReason };
  }
  return { category: "unknown", detail: nativeReason };
}

/**
 * Branch naming observed live (P3/P16): agent/<agent-name>/<task-id-first-8>.
 * Advisory by design — stable only within a daemon lifetime (P7); the conductor
 * resolves it to a SHA once at report time. Assumes ref-safe agent names, which
 * Guild controls; the conformance suite proves the convention on pin bumps.
 */
export function branchHintFor(agentName: string, taskId: string): string {
  return `agent/${agentName}/${taskId.slice(0, 8)}`;
}

/**
 * Idempotency marker for findWorkItem. Issue metadata is NOT persisted by the
 * create endpoint (verified live 2026-07-31), so the marker rides in the
 * description as an HTML comment — invisible on the board, trivially parseable.
 */
const MARKER_RE = /<!-- guild:engagement=([A-Za-z0-9_-]+) -->/;

export function embedEngagementMarker(description: string, engagementId: string): string {
  return `${description}\n\n<!-- guild:engagement=${engagementId} -->`;
}

export function extractEngagementId(description: string): string | null {
  return MARKER_RE.exec(description)?.[1] ?? null;
}

/**
 * HTTP fault → stable category. 400/405/422 mean our model of the API has
 * diverged from the pinned substrate (adapter bug or unreviewed pin bump) —
 * that is desync, not transport. 429 here is the substrate's own API limit
 * (not the model-provider 429, which arrives as a task failure — P10).
 */
export function classifyHttpError(httpStatus: number): Omit<SubstrateError, "message"> {
  if (httpStatus === 401 || httpStatus === 403) return { category: "auth", retryable: false };
  if (httpStatus === 404) return { category: "not_found", retryable: false };
  if (httpStatus === 409) return { category: "conflict", retryable: false };
  if (httpStatus === 429) return { category: "transport", retryable: true };
  if (httpStatus >= 500) return { category: "substrate_internal", retryable: true };
  return { category: "desync", retryable: false };
}
