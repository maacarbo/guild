/**
 * Pure snapshot derivation: (issue, task runs) → WorkItemSnapshot.
 * One engagement = one issue (D8 context-freshness); runs are per-trigger.
 * The LATEST run carries the status; the latest COMPLETED run carries the
 * report while a bounce is in flight (running/queued must not erase it) —
 * but a LATER failed/cancelled run suppresses it: the failure is then the
 * actionable signal, and a stale success artifact next to a failed status
 * would read as fresh work (M1b verify finding).
 */

import type { WorkItemRef, WorkItemSnapshot } from "@guild/shared";
import type { MulticaIssue, MulticaTaskRun } from "./multica-types.js";
import { branchHintFor, classifyFailure, statusFromTaskState } from "./translation.js";

function latestOf(runs: MulticaTaskRun[]): MulticaTaskRun | undefined {
  return [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
}

export function deriveSnapshot(
  item: WorkItemRef,
  issue: MulticaIssue,
  runs: MulticaTaskRun[],
  agentName: string,
): WorkItemSnapshot {
  const latest = latestOf(runs);
  const latestCompleted = latestOf(runs.filter((r) => r.status === "completed" && r.result));
  const reportStale =
    latestCompleted !== undefined &&
    latest !== undefined &&
    latest.id !== latestCompleted.id &&
    (latest.status === "failed" || latest.status === "cancelled");

  const timestamps = [
    issue.updated_at,
    ...runs.flatMap((r) => [r.created_at, r.started_at ?? "", r.completed_at ?? ""]),
  ].filter(Boolean);

  return {
    item,
    status: latest ? statusFromTaskState(latest.status) : "queued",
    nativeStatus: `issue:${issue.status};task:${latest?.status ?? "none"}`,
    ...(latest?.status === "failed"
      ? { failure: classifyFailure(latest.failure_reason ?? latest.error) }
      : {}),
    ...(latestCompleted?.result && !reportStale
      ? {
          report: {
            summary: latestCompleted.result.output,
            branchHint: branchHintFor(agentName, latestCompleted.id),
          },
        }
      : {}),
    ...(issue.assignee_id ? { assignedAgent: issue.assignee_id } : {}),
    updatedAt: timestamps.sort((a, b) => a.localeCompare(b)).at(-1) ?? issue.updated_at,
  };
}
