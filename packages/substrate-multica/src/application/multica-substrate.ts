/**
 * ExecutionSubstrate implementation over the MulticaApi port — Multica
 * vocabulary in, @guild/shared language out (D8 anti-corruption layer).
 * All Multica-specific semantics live here or in domain/; nothing native
 * crosses the package boundary.
 */

import type {
  CancellationReason,
  ContractVerdict,
  ExecutionSubstrate,
  SubstrateEvent,
  WorkItemRef,
  WorkItemSnapshot,
  WorkItemSpec,
} from "@guild/shared";
import { renderBounceComment } from "../domain/bounce.js";
import { renderBrief } from "../domain/brief.js";
import { substrateEventFromFrame } from "../domain/events.js";
import { deriveSnapshot } from "../domain/snapshot.js";
import { classifyHttpError, embedEngagementMarker, extractEngagementId } from "../domain/translation.js";
import type { MulticaApi } from "../ports/multica-api.js";
import { MulticaHttpError } from "../ports/multica-api.js";
import { SubstrateFault } from "./substrate-fault.js";

/** native run states with a live process or a pending claim — cancel targets these (P4) */
const NON_TERMINAL_STATES = new Set(["queued", "dispatched", "running", "waiting_local_directory", "deferred"]);

export interface RoleBinding {
  agentId: string;
  agentName: string;
}

export interface MulticaSubstrateConfig {
  /** the workspace this instance is bound to — listWorkItems/watch scope must match */
  projectScope: string;
  /** role → Multica agent binding; roles are Guild vocabulary, agents are substrate state */
  roleAgents: Record<string, RoleBinding>;
}

export class MulticaSubstrate implements ExecutionSubstrate {
  readonly name = "multica";
  private readonly agentNames = new Map<string, string>();

  constructor(
    private readonly api: MulticaApi,
    private readonly config: MulticaSubstrateConfig,
  ) {
    for (const binding of Object.values(config.roleAgents)) {
      this.agentNames.set(binding.agentId, binding.agentName);
    }
  }

  private async fail(e: unknown): Promise<never> {
    if (e instanceof MulticaHttpError) {
      const { category, retryable } = classifyHttpError(e.httpStatus);
      throw new SubstrateFault(category, retryable, e.message);
    }
    if (e instanceof SubstrateFault) throw e;
    throw new SubstrateFault(
      "transport",
      true,
      e instanceof Error ? e.message : String(e),
    );
  }

  private async agentNameFor(agentId: string): Promise<string> {
    const known = this.agentNames.get(agentId);
    if (known) return known;
    const agent = await this.api.getAgent(agentId);
    this.agentNames.set(agentId, agent.name);
    return agent.name;
  }

  private assertScope(projectScope: string): void {
    if (projectScope !== this.config.projectScope) {
      throw new SubstrateFault(
        "desync",
        false,
        `this substrate instance is bound to scope ${this.config.projectScope}, not ${projectScope}`,
      );
    }
  }

  async createWorkItem(spec: WorkItemSpec): Promise<WorkItemRef> {
    const binding = this.config.roleAgents[spec.role];
    if (!binding) {
      throw new SubstrateFault(
        "unsupported_capability",
        false,
        `no agent is bound to role "${spec.role}" — add it to MulticaSubstrateConfig.roleAgents`,
      );
    }
    try {
      const description = embedEngagementMarker(renderBrief(spec.brief), spec.engagementId);
      const issue = await this.api.createIssue({ title: spec.title, description });
      await this.api.updateIssue(issue.id, { assignee_id: binding.agentId, assignee_type: "agent" });
      return { substrate: this.name, externalId: issue.id };
    } catch (e) {
      return this.fail(e);
    }
  }

  async findWorkItem(engagementId: string): Promise<WorkItemRef | null> {
    try {
      const issues = await this.api.listIssues();
      const match = issues.find((i) => extractEngagementId(i.description) === engagementId);
      return match ? { substrate: this.name, externalId: match.id } : null;
    } catch (e) {
      return this.fail(e);
    }
  }

  async getWorkItem(item: WorkItemRef): Promise<WorkItemSnapshot> {
    try {
      const issue = await this.api.getIssue(item.externalId);
      const runs = await this.api.listTaskRuns(item.externalId);
      const agentName = issue.assignee_id ? await this.agentNameFor(issue.assignee_id) : "";
      return deriveSnapshot(item, issue, runs, agentName);
    } catch (e) {
      return this.fail(e);
    }
  }

  async listWorkItems(projectScope: string): Promise<WorkItemSnapshot[]> {
    this.assertScope(projectScope);
    try {
      const issues = await this.api.listIssues();
      const guildIssues = issues.filter((i) => extractEngagementId(i.description) !== null);
      return Promise.all(
        guildIssues.map((i) => this.getWorkItem({ substrate: this.name, externalId: i.id })),
      );
    } catch (e) {
      return this.fail(e);
    }
  }

  async assign(item: WorkItemRef, agent: string): Promise<void> {
    try {
      await this.api.updateIssue(item.externalId, { assignee_id: agent, assignee_type: "agent" });
    } catch (e) {
      return this.fail(e);
    }
  }

  async comment(item: WorkItemRef, body: string, opts?: { inReplyTo?: string }): Promise<void> {
    try {
      await this.api.createComment(item.externalId, body, opts?.inReplyTo);
    } catch (e) {
      return this.fail(e);
    }
  }

  async requestRework(item: WorkItemRef, verdict: ContractVerdict): Promise<void> {
    try {
      await this.api.createComment(item.externalId, renderBounceComment(verdict));
    } catch (e) {
      return this.fail(e);
    }
  }

  async cancel(item: WorkItemRef, _reason: CancellationReason): Promise<void> {
    try {
      const runs = await this.api.listTaskRuns(item.externalId);
      for (const run of runs.filter((r) => NON_TERMINAL_STATES.has(r.status))) {
        await this.api.cancelTask(run.id);
      }
    } catch (e) {
      return this.fail(e);
    }
  }

  async close(item: WorkItemRef): Promise<void> {
    try {
      await this.api.updateIssue(item.externalId, { status: "done" });
    } catch (e) {
      return this.fail(e);
    }
  }

  async *watch(projectScope: string): AsyncIterable<SubstrateEvent> {
    this.assertScope(projectScope);
    // eventId synthesis: per-stream nonce + sequence (the substrate carries no ids)
    const nonce = `${projectScope.slice(0, 8)}-${process.hrtime.bigint().toString(36)}`;
    let seq = 0;
    for await (const frame of this.api.watchWorkspace()) {
      const raw = substrateEventFromFrame(this.name, frame, new Date().toISOString());
      if (raw) yield { ...raw, eventId: `${nonce}:${++seq}` };
    }
  }
}
