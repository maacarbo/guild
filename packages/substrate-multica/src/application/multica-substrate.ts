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
  HireSpec,
  Lane,
  SubstrateEvent,
  TicketSpec,
  WorkItemComment,
  WorkItemRef,
  WorkItemSnapshot,
  WorkItemSpec,
} from "@guild/shared";
import { renderBounceComment } from "../domain/bounce.js";
import { renderBrief } from "../domain/brief.js";
import { substrateEventFromFrame } from "../domain/events.js";
import { deriveSnapshot } from "../domain/snapshot.js";
import {
  actorFrom,
  classifyHttpError,
  embedEngagementMarker,
  extractEngagementId,
  nativeStatusFromLane,
} from "../domain/translation.js";
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
  /**
   * the conductor's own Multica member id (D11: the conductor runs under its
   * own member identity) — lane_moved attribution hinges on it (P22): this id
   * is "conductor"
   */
  selfMemberId: string;
  /**
   * extra env folded into every engagement bind (#6, D17): today the
   * per-project git credential NAME (GUILD_GIT_CRED=<daemon env var name>) —
   * name-indirection keeps credential VALUES out of Guild entirely. The
   * per-engagement key always wins a collision.
   */
  engagementEnv?: Record<string, string>;
  /**
   * explicit operator member allowlist (D15, audit #17 A5d): a member move/creation
   * reads as "operator" only if its actor id is on this list — every other member is
   * "unknown". Required (not optional) so no composition root silently omits it; the
   * conductor's composition root asserts it is non-empty and excludes selfMemberId and
   * the daemon identity (an empty list would fail-closed and deadlock board approvals).
   */
  operatorMemberIds: readonly string[];
}

export class MulticaSubstrate implements ExecutionSubstrate {
  readonly name = "multica";
  private readonly agentNames = new Map<string, string>();
  /** role → agent binding; seeded from config, mutated ONLY by hire/retire (M3) */
  private readonly roleBindings = new Map<string, RoleBinding>();

  constructor(
    private readonly api: MulticaApi,
    private readonly config: MulticaSubstrateConfig,
  ) {
    for (const [role, binding] of Object.entries(config.roleAgents)) {
      this.roleBindings.set(role, binding);
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
    try {
      const agent = await this.api.getAgent(agentId);
      this.agentNames.set(agentId, agent.name);
      return agent.name;
    } catch (e) {
      if (!(e instanceof MulticaHttpError) || e.httpStatus !== 404) throw e;
      // M3 retire = archive: the agent leaves getAgent but its historical
      // items remain on the board, and reconcile reads EVERY item — a name
      // lookup must degrade (archived listing, then the bare id), never
      // abort the read path. Cached either way: one miss, not one per pass.
      const archived = (await this.api.listAgents({ includeArchived: true })).find((a) => a.id === agentId);
      const name = archived?.name ?? agentId;
      this.agentNames.set(agentId, name);
      return name;
    }
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
    const binding = this.roleBindings.get(spec.role);
    if (!binding) {
      throw new SubstrateFault(
        "unsupported_capability",
        false,
        `no agent is bound to role "${spec.role}" — add it to MulticaSubstrateConfig.roleAgents`,
      );
    }
    try {
      // The engagement marker is written LAST — it is the commit point of the
      // dispatch saga. create/assign are not atomic on this substrate; if
      // either fails, no marker exists yet, findWorkItem stays null, and the
      // conductor's retry starts clean instead of finding a half-dispatched
      // orphan (M1b verify finding). The marker is invisible agent-side, so
      // appending it after assignment cannot change the brief the agent reads.
      const brief = renderBrief(spec.brief);
      const issue = await this.api.createIssue({ title: spec.title, description: brief });
      await this.api.updateIssue(issue.id, { assignee_id: binding.agentId, assignee_type: "agent" });
      try {
        await this.api.updateIssue(issue.id, {
          description: embedEngagementMarker(brief, spec.engagementId),
        });
      } catch (markerFailure) {
        // The issue is assigned and may already be running, but carries no
        // marker — invisible to findWorkItem, so a retry would duplicate it.
        // Compensate best-effort: stop its work and close it before failing,
        // leaving nothing ungoverned behind (M1b verify finding). The
        // conductor's liveness repair is the backstop if compensation fails.
        try {
          const runs = await this.api.listTaskRuns(issue.id);
          for (const run of runs.filter((r) => NON_TERMINAL_STATES.has(r.status))) {
            await this.api.cancelTask(run.id);
          }
          await this.api.updateIssue(issue.id, { status: "done" });
        } catch {
          // best effort only — the original fault is the one to surface
        }
        throw markerFailure;
      }
      return { substrate: this.name, externalId: issue.id };
    } catch (e) {
      return this.fail(e);
    }
  }

  async createTicket(spec: TicketSpec): Promise<WorkItemRef> {
    try {
      // marker-last is the commit point, same saga rule as createWorkItem: an
      // unmarkered ticket is invisible to findWorkItem, so a retry starts
      // clean. Compensation differs — a governance ticket runs nothing, so a
      // marker failure just moves the orphan off-board (cancelled), best-effort.
      const issue = await this.api.createIssue({ title: spec.title, description: spec.body });
      try {
        await this.api.updateIssue(issue.id, {
          description: embedEngagementMarker(spec.body, spec.markerId),
        });
      } catch (markerFailure) {
        try {
          await this.api.updateIssue(issue.id, { status: nativeStatusFromLane("cancelled") });
        } catch {
          // best effort only — the original fault is the one to surface
        }
        throw markerFailure;
      }
      return { substrate: this.name, externalId: issue.id };
    } catch (e) {
      return this.fail(e);
    }
  }

  async findWorkItem(engagementId: string): Promise<WorkItemRef | null> {
    try {
      const issues = await this.api.listIssues();
      // Guild only ever looks up items IT created (engagement work items and
      // governance tickets are all conductor-authored). Binding on the marker
      // alone let a planted issue carrying a derivable gate/engagement marker be
      // adopted as the real one — a self-approval injection (A5a). Constrain the
      // match to the conductor's own creations (P25 creator attribution).
      const match = issues.find(
        (i) => i.creator_id === this.config.selfMemberId && extractEngagementId(i.description) === engagementId,
      );
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
      return deriveSnapshot(item, issue, runs, agentName, this.config.selfMemberId, this.config.operatorMemberIds);
    } catch (e) {
      return this.fail(e);
    }
  }

  async listWorkItems(projectScope: string): Promise<WorkItemSnapshot[]> {
    this.assertScope(projectScope);
    try {
      // the WHOLE board (M2b): marker-less items are the idea candidates —
      // marker discipline is the caller's, via snapshot.markerId (D12)
      const issues = await this.api.listIssues();
      return Promise.all(issues.map((i) => this.getWorkItem({ substrate: this.name, externalId: i.id })));
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

  async bindEngagementKey(role: string, key: string): Promise<void> {
    const binding = this.roleBindings.get(role);
    if (!binding) {
      throw new SubstrateFault(
        "unsupported_capability",
        false,
        `no agent is bound to role "${role}" — add it to MulticaSubstrateConfig.roleAgents`,
      );
    }
    try {
      // wholesale replacement leans on one open engagement per agent — guarded
      // at the gate (domain/stage.ts duplicateOpenRole flags role repeats).
      // GUILD_DAEMON_VIRTUAL_KEY is the daemon image's gateway-credential hook
      // (proven end-to-end at M1: per-engagement spend attribution); the
      // configured engagementEnv rides along (#6) and never outranks the key.
      await this.api.updateAgentEnv(binding.agentId, {
        ...this.config.engagementEnv,
        GUILD_DAEMON_VIRTUAL_KEY: key,
      });
    } catch (e) {
      return this.fail(e);
    }
  }

  async setLane(item: WorkItemRef, lane: Lane): Promise<void> {
    try {
      await this.api.updateIssue(item.externalId, { status: nativeStatusFromLane(lane) });
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

  async hireAgent(spec: HireSpec): Promise<{ hired: boolean; agentId: string }> {
    const bound = this.roleBindings.get(spec.role);
    if (bound) return { hired: false, agentId: bound.agentId };
    try {
      // agents bind to a runtime at creation (backend rejects runtime_id-less
      // creates) and only an ONLINE runtime's daemon dispatches — probed live
      // 2026-08-11: creation on the online runtime reached task_run running
      // with no daemon restart
      const online = (await this.api.listRuntimes()).find((r) => r.status === "online");
      if (!online) {
        throw new SubstrateFault("substrate_internal", true, "no online runtime to hire onto — is the daemon up?");
      }
      let agentId: string;
      try {
        agentId = (await this.api.createAgent({ name: spec.agentName, runtime_id: online.id, model: spec.model })).id;
      } catch (e) {
        // crashed-hire re-drive: the same-name agent already exists — adopt it
        // rather than duplicate (names are unique per hire by contract)
        if (!(e instanceof MulticaHttpError) || e.httpStatus !== 409) throw e;
        const existing = (await this.api.listAgents()).find((a) => a.name === spec.agentName);
        if (!existing) {
          throw new SubstrateFault(
            "substrate_internal",
            false,
            `agent name "${spec.agentName}" is reserved by a retired agent — hire names must be unique per hire`,
          );
        }
        agentId = existing.id;
      }
      this.roleBindings.set(spec.role, { agentId, agentName: spec.agentName });
      this.agentNames.set(agentId, spec.agentName);
      return { hired: true, agentId };
    } catch (e) {
      return this.fail(e);
    }
  }

  async retireAgent(role: string, hint?: { agentId?: string }): Promise<{ retired: boolean; agentId?: string }> {
    const binding = this.roleBindings.get(role);
    // the hint WINS: a run retires the agent IT hired. If the role has since
    // been re-bound to someone else (a later hire, or static config after a
    // restart), that other agent is not this run's to retire.
    const agentId = hint?.agentId ?? binding?.agentId;
    if (!agentId) return { retired: false };
    try {
      try {
        await this.api.archiveAgent(agentId);
      } catch (e) {
        // already archived (crash-redrive or prior-process retire): the
        // retirement this call wants EXISTS — converge, the caller's decision
        // entry is still owed. Live wire (2026-08-11): re-archive is 409
        // "agent is already archived"; 404 covers a fully-vanished row. The
        // archived listing is the arbiter either way; anything else rethrows.
        if (!(e instanceof MulticaHttpError) || (e.httpStatus !== 404 && e.httpStatus !== 409)) throw e;
        const archived = (await this.api.listAgents({ includeArchived: true })).some((a) => a.id === agentId);
        if (!archived) throw e;
      }
      if (binding?.agentId === agentId) this.roleBindings.delete(role);
      return { retired: true, agentId };
    } catch (e) {
      return this.fail(e);
    }
  }

  async listComments(item: WorkItemRef): Promise<WorkItemComment[]> {
    try {
      const comments = await this.api.listComments(item.externalId);
      // actor attribution MUST match the live comment-event mapping
      // (domain/events.ts) — a divergent reconcile path would let a downtime
      // comment be attributed differently than the same comment live (D15)
      return comments.map((c) => ({
        commentId: c.id,
        author: c.author_id ?? c.author_type ?? "",
        actor: actorFrom(c.author_type, c.author_id, this.config.selfMemberId, this.config.operatorMemberIds),
        body: c.content ?? "",
        at: c.created_at ?? "",
        inReplyTo: c.parent_id ?? null,
      }));
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

  async close(item: WorkItemRef, terminalLane: Lane = "done"): Promise<void> {
    try {
      // the terminal lane is the board truth: cancelled/killed/capped work must
      // land in the cancelled status, never Done (D11 lane table; #17 B9)
      await this.api.updateIssue(item.externalId, { status: nativeStatusFromLane(terminalLane) });
    } catch (e) {
      return this.fail(e);
    }
  }

  async *watch(projectScope: string, opts?: { signal?: AbortSignal }): AsyncIterable<SubstrateEvent> {
    this.assertScope(projectScope);
    // eventId synthesis: per-stream nonce + sequence (the substrate carries no ids)
    const nonce = `${projectScope.slice(0, 8)}-${process.hrtime.bigint().toString(36)}`;
    let seq = 0;
    for await (const frame of this.api.watchWorkspace(opts?.signal)) {
      const raw = substrateEventFromFrame(
        this.name,
        frame,
        new Date().toISOString(),
        this.config.selfMemberId,
        this.config.operatorMemberIds,
      );
      if (raw) yield { ...raw, eventId: `${nonce}:${++seq}` };
    }
  }
}
