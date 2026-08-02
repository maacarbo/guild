/**
 * MulticaApi over fetch + WebSocket against a live control plane (v0.4.15).
 * Endpoint shapes verified live (M1a P13/P14 + M1b write-path probes):
 * - issues list is paginated `{issues, total}` (limit/offset); other lists are arrays
 * - issue updates are PUT (PATCH → 405)
 * - WS auth is the first frame `{"type":"auth","payload":{"token":…}}`
 */

import type { MulticaAgent, MulticaComment, MulticaIssue, MulticaTaskRun } from "../domain/multica-types.js";
import type { MulticaApi, MulticaWsFrame } from "../ports/multica-api.js";
import { MulticaHttpError } from "../ports/multica-api.js";

export interface FetchMulticaApiConfig {
  baseUrl: string;
  token: string;
  workspaceId: string;
}

const PAGE_SIZE = 100;

export class FetchMulticaApi implements MulticaApi {
  constructor(private readonly config: FetchMulticaApiConfig) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "x-workspace-id": this.config.workspaceId,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new MulticaHttpError(res.status, `${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  createIssue(input: { title: string; description: string }): Promise<MulticaIssue> {
    // Guild does not require unique work-item titles; without this flag the
    // control plane 409s on same-title active issues (verified live 2026-07-31:
    // code "active_duplicate_issue")
    return this.request("POST", "/api/issues", { ...input, allow_duplicate: true });
  }

  getIssue(id: string): Promise<MulticaIssue> {
    return this.request("GET", `/api/issues/${id}`);
  }

  async listIssues(): Promise<MulticaIssue[]> {
    // Offset pagination drifts when rows are created/deleted mid-iteration —
    // a shifted row can vanish from every page while the count still looks
    // complete (M1b verify finding). A sweep is trusted only when it is
    // self-consistent (collected == its own first-page total, or the pages
    // ran out); an inconsistent sweep is retried from scratch, and sustained
    // churn fails loud as a retryable fault instead of returning a silently
    // incomplete list.
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = new Map<string, MulticaIssue>();
      let offset = 0;
      let target: number | null = null;
      let exhausted = false;
      while (!exhausted && seen.size < (target ?? Number.POSITIVE_INFINITY)) {
        const page = await this.request<{ issues: MulticaIssue[]; total: number }>(
          "GET",
          `/api/issues?limit=${PAGE_SIZE}&offset=${offset}`,
        );
        target ??= page.total;
        for (const issue of page.issues) seen.set(issue.id, issue);
        offset += page.issues.length;
        exhausted = page.issues.length === 0;
      }
      if (seen.size >= (target ?? 0) || !exhausted) return [...seen.values()];
    }
    throw new Error("issue listing did not stabilize across 3 sweeps (concurrent churn)");
  }

  updateIssue(id: string, patch: Partial<MulticaIssue> & { assignee_type?: string }): Promise<MulticaIssue> {
    return this.request("PUT", `/api/issues/${id}`, patch);
  }

  listTaskRuns(issueId: string): Promise<MulticaTaskRun[]> {
    return this.request("GET", `/api/issues/${issueId}/task-runs`);
  }

  createComment(issueId: string, content: string, parentId?: string): Promise<MulticaComment> {
    return this.request("POST", `/api/issues/${issueId}/comments`, {
      content,
      ...(parentId ? { parent_id: parentId } : {}),
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.request("POST", `/api/tasks/${taskId}/cancel`);
  }

  async getAgent(id: string): Promise<MulticaAgent> {
    const agents = await this.request<MulticaAgent[]>("GET", "/api/agents");
    const agent = agents.find((a) => a.id === id);
    if (!agent) throw new MulticaHttpError(404, `agent ${id} not found in workspace`);
    return agent;
  }

  async updateAgentEnv(agentId: string, env: Record<string, string>): Promise<void> {
    await this.request("PUT", `/api/agents/${agentId}/env`, { custom_env: env });
  }

  async *watchWorkspace(signal?: AbortSignal): AsyncIterable<MulticaWsFrame> {
    const wsUrl = `${this.config.baseUrl.replace(/^http/, "ws")}/ws?workspace_id=${this.config.workspaceId}`;
    const ws = new WebSocket(wsUrl);
    const queue: MulticaWsFrame[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let failure: Error | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", payload: { token: this.config.token } }));
    ws.onmessage = (ev) => {
      try {
        queue.push(JSON.parse(String(ev.data)) as MulticaWsFrame);
      } catch {
        // non-JSON frame: drop — reconciliation reads are the truth path
      }
      notify();
    };
    ws.onerror = () => {
      failure = new Error(`websocket error against ${wsUrl}`);
      notify();
    };
    ws.onclose = () => {
      closed = true;
      notify();
    };
    signal?.addEventListener("abort", () => ws.close());
    try {
      while (true) {
        const frame = queue.shift();
        if (frame) {
          yield frame;
          continue;
        }
        if (failure) throw failure;
        if (closed || signal?.aborted) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      ws.close();
    }
  }
}
