/**
 * Internal driven port over Multica's REST/WS surface — owned by the inside so
 * the substrate service can be unit-tested against a fake (CLAUDE.md: don't
 * mock what you don't own; wrap it in a port and fake the port). One instance
 * is bound to one (base URL, token, workspace).
 */

import type { MulticaAgent, MulticaComment, MulticaIssue, MulticaTaskRun , MulticaRuntime } from "../domain/multica-types.js";

/** raw WS frame: `{"type":"task:running","payload":{…}}` (M1a P14) */
export interface MulticaWsFrame {
  type: string;
  payload: unknown;
}

/** thrown by adapters on non-2xx responses; classified at the application layer */
export class MulticaHttpError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "MulticaHttpError";
  }
}

export interface MulticaApi {
  createIssue(input: { title: string; description: string }): Promise<MulticaIssue>;
  getIssue(id: string): Promise<MulticaIssue>;
  listIssues(): Promise<MulticaIssue[]>;
  updateIssue(id: string, patch: Partial<MulticaIssue> & { assignee_type?: string }): Promise<MulticaIssue>;
  listTaskRuns(issueId: string): Promise<MulticaTaskRun[]>;
  createComment(issueId: string, content: string, parentId?: string): Promise<MulticaComment>;
  /** reconciliation read (#12): the issue's comments, as returned by the backend (chronological) */
  listComments(issueId: string): Promise<MulticaComment[]>;
  cancelTask(taskId: string): Promise<void>;
  getAgent(id: string): Promise<MulticaAgent>;
  /** M3: archived agents (retired hires) leave the default listing but their items remain readable */
  listAgents(opts?: { includeArchived?: boolean }): Promise<MulticaAgent[]>;
  /** M3 hiring: agents bind to an existing runtime at creation (backend rejects runtime_id-less creates) */
  listRuntimes(): Promise<MulticaRuntime[]>;
  createAgent(spec: { name: string; runtime_id: string; model: string; description?: string }): Promise<MulticaAgent>;
  /** the ONLY retire the API exposes (DELETE is 405); archive is one-way by Guild decision — never /restore */
  archiveAgent(id: string): Promise<void>;
  /** wholesale custom_env replacement — v0.4.15 dedicated endpoint, member-token auth (M1b live) */
  updateAgentEnv(agentId: string, env: Record<string, string>): Promise<void>;
  /** long-lived frame stream; ends on disconnect — the caller owns reconnect/reconcile */
  watchWorkspace(signal?: AbortSignal): AsyncIterable<MulticaWsFrame>;
}
