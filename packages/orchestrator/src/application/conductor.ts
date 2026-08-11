/**
 * The engagement conductor — M2a's governed core loop generalized to the M2b
 * multi-stage pipeline (issue #2): idea detection → deterministic plan (D12) →
 * per-stage board gates → dispatch sagas → SHA-pinned validation → bounce |
 * accept → stage sequencing → termination protocol, every transition appended
 * to the decision trail.
 *
 * Zero discretion, full mechanics (D11): this class never invents work — it
 * only executes transitions a human-approved plan authorizes and a validated
 * contract permits. Operator lane moves are the only approvals; agent lane
 * moves are never forward signals; its own moves come back as attributed
 * echoes and are ignored.
 *
 * Concurrency (#11): every public entry point runs through one in-process
 * mutex, so events, reconciliation, and watchdog sweeps never interleave at
 * await points; the store's state-CAS saves and first-writer-wins gate
 * decisions protect the cross-process case on top.
 */

import type {
  CancellationReason,
  ContractCheck,
  ContractVerdict,
  EngagementPlan,
  EngagementState,
  ExecutionSubstrate,
  GateDecision,
  KeySpend,
  ModelGateway,
  ProjectBudget,
  StageKind,
  StagePlan,
  SubstrateEvent,
  WorkItemRef,
  WorkItemSnapshot,
} from "@guild/shared";
import { MAX_BOUNCES } from "@guild/shared";
import { applyGateDecision } from "../domain/gate.js";
import { laneFor } from "../domain/lane.js";
import { templateFor } from "../domain/templates.js";
import {
  STAGE_ORDER,
  deriveStagePlan,
  handoffPathFor,
  isAmendNote,
  parseHandoffChecks,
  roleFor,
  type Idea,
  type UpstreamHandoff,
} from "../domain/planner.js";
import { transition, type EngagementEvent } from "../domain/engagement.js";
import type {
  EngagementRecord,
  GateTicketKey,
  GovernanceStore,
  PlanRunRecord,
} from "../ports/governance-store.js";
import type { SourceControl } from "../ports/source-control.js";
import type { ValidationInput } from "./contract-validator.js";

export interface ConductorDeps {
  substrate: ExecutionSubstrate;
  gateway: ModelGateway;
  validator: { validate(input: ValidationInput): Promise<ContractVerdict> };
  source: SourceControl;
  store: GovernanceStore;
  now?: () => string;
}

export interface ConductorConfig {
  projectScope: string;
  /** the product repository engagement branches land in */
  repoUrl: string;
  /** the branch acceptance fast-forwards (D6: merges are Guild-mediated, ff-only) */
  targetBranch: string;
  /** governs derived plans when the idea names no budget: directive (D12) */
  defaultPlanBudgetCents: number;
  /** the project ceiling the watchdog enforces; absent = engagement caps only */
  projectBudget?: ProjectBudget;
  /** engagement soft-cap warning threshold as a fraction of budgetCents (D12 default 0.8) */
  softCapRatio?: number;
}

const TERMINAL_WORK: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);
/** states holding a live key whose work the hard cap cancels — validated work survives (D12) */
const SPENDING: ReadonlySet<EngagementState> = new Set(["dispatched", "working", "blocked", "reported", "bounced"]);
const TERMINAL_STATES: ReadonlySet<EngagementState> = new Set(["accepted", "cancelled", "escalated"]);

/** stage ids are conductor-minted as `stg:<ideaId>:<kind>` (planner identity rule) */
function stageKindOf(stageId: string): StageKind {
  return stageId.slice(stageId.lastIndexOf(":") + 1) as StageKind;
}

export class Conductor {
  private readonly now: () => string;
  /** the in-process mutex: public entry points chain here, internals never re-enter */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: ConductorDeps,
    private readonly config: ConductorConfig,
  ) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  // ------------------------------------------------------- public surface

  /** route one substrate event; unknown items and non-signals are ignored */
  handleEvent(ev: SubstrateEvent): Promise<void> {
    return this.serialize(() => this.routeEvent(ev));
  }

  /** event loop for live operation; unit tests drive handleEvent directly */
  async run(opts?: { signal?: AbortSignal }): Promise<void> {
    for await (const ev of this.deps.substrate.watch(this.config.projectScope, opts)) {
      await this.handleEvent(ev);
    }
  }

  /**
   * Recover from reads (the truth path): adopt ideas that appeared while
   * down, resume crashed dispatch sagas, honor gate and acceptance moves the
   * operator made in the gap, catch up missed task transitions, and advance
   * completed stages. Idempotent — a settled state reconciles to zero new
   * decisions.
   */
  reconcile(): Promise<void> {
    return this.serialize(() => this.reconcileUnsafe());
  }

  /**
   * Adopt an externally-authored stage plan as a single-stage run (harness /
   * M2a compatibility): persists the plan and its run; the caller then posts
   * the gate via postStageForApproval.
   */
  adoptStagePlan(plan: StagePlan): Promise<void> {
    return this.serialize(async () => {
      await this.deps.store.saveStagePlan(plan);
      if (!(await this.deps.store.getPlanRun(plan.stageId))) {
        await this.deps.store.savePlanRun({ planId: plan.stageId, stageIds: [plan.stageId], status: "active" });
      }
    });
  }

  postStageForApproval(stageId: string): Promise<WorkItemRef> {
    return this.serialize(async () => {
      const plan = await this.deps.store.getLatestStagePlan(stageId);
      if (!plan) throw new Error(`no persisted plan for stage ${stageId}`);
      return this.postGate(plan, []);
    });
  }

  /**
   * The budget watchdog pass (D12): engagement soft caps warn once; the
   * project hard cap cancels every spending engagement, locks dispatch, and
   * explains itself on the idea ticket; a raised cap releases the lock — the
   * only exit. Metered from the gateway: it is the spend source of truth.
   */
  sweep(): Promise<void> {
    return this.serialize(() => this.sweepUnsafe());
  }

  private async sweepUnsafe(): Promise<void> {
    const minted = await this.deps.store.listDispatchIntents();
    if (minted.length === 0) return;
    const spends = new Map<string, KeySpend>();
    for (const id of minted) {
      try {
        const spend = await this.deps.gateway.getSpend(id);
        // null = revoked — its final reading rides in the termination entry
        if (spend) spends.set(id, spend);
      } catch {
        // transient read failure — skip this key this pass; the next sweep retries
      }
    }
    const decisions = await this.deps.store.listDecisions();
    const records = await this.deps.store.listEngagements();
    const ratio = this.config.softCapRatio ?? 0.8;

    // engagement soft caps — one warning each, deduped through the trail
    for (const rec of records) {
      if (!SPENDING.has(rec.state) && rec.state !== "validated") continue;
      const spend = spends.get(rec.engagementId);
      if (!spend || spend.budgetCents <= 0) continue;
      const capCents = Math.floor(spend.budgetCents * ratio);
      if (spend.spentCents < capCents) continue;
      const warned = decisions.some(
        (d) =>
          d.kind === "budget" &&
          d.event.kind === "soft_cap" &&
          d.event.scope === "engagement" &&
          d.event.engagementId === rec.engagementId,
      );
      if (warned) continue;
      await this.deps.store.appendDecision({
        kind: "budget",
        event: {
          kind: "soft_cap",
          scope: "engagement",
          engagementId: rec.engagementId,
          spentCents: spend.spentCents,
          capCents,
          at: this.now(),
        },
      });
      if (rec.item) {
        await this.deps.substrate.comment(
          rec.item,
          `Budget soft cap: this engagement has spent ${spend.spentCents}¢ of its ${spend.budgetCents}¢ cap. The gateway hard-stops at the cap.`,
        );
      }
    }

    const budget = this.config.projectBudget;
    if (!budget) return;
    // project total = live keys + terminated recordings (last entry wins);
    // a live reading supersedes the recording for the same engagement
    const terminatedSpend = new Map<string, number>();
    for (const d of decisions) {
      if (d.kind === "termination" && d.terminated.spentCents !== undefined) {
        terminatedSpend.set(d.terminated.engagementId, d.terminated.spentCents);
      }
    }
    let totalSpent = [...spends.values()].reduce((sum, s) => sum + s.spentCents, 0);
    for (const [id, cents] of terminatedSpend) if (!spends.has(id)) totalSpent += cents;
    // #12: the revoke→termination-entry window — a terminal record whose final
    // reading was persisted but whose entry hasn't landed yet still counts
    for (const rec of records) {
      if (!TERMINAL_STATES.has(rec.state) || rec.terminalSpendCents === undefined) continue;
      if (spends.has(rec.engagementId) || terminatedSpend.has(rec.engagementId)) continue;
      totalSpent += rec.terminalSpendCents;
    }

    const lock = await this.deps.store.getDispatchLock();
    if (lock) {
      // Raise-the-cap-and-restart (D12) is the ONLY sweep-driven exit, and it
      // is gated on a genuine raise: the configured hard cap must exceed the cap
      // in force when the lock was set. Spend alone must never release a lock —
      // the kill switch fires while spend is below the cap (A1), so a
      // spend-below-cap release would clear `guild kill` on the very next tick.
      // A lock with no recorded cap (a kill with no project budget) is never
      // released here; recovery is a deliberate operator act, never automatic.
      if (lock.capCents !== undefined && budget.hardCapCents > lock.capCents) {
        await this.deps.store.clearDispatchLock();
        await this.deps.store.appendDecision({
          kind: "budget",
          event: { kind: "lock_released", spentCents: totalSpent, capCents: budget.hardCapCents, at: this.now() },
        });
      }
      return;
    }

    if (totalSpent >= budget.hardCapCents) {
      const cancelled: string[] = [];
      for (const rec of records) {
        if (!SPENDING.has(rec.state)) continue;
        await this.cancelEngagement(rec, "budget_hard_cap");
        cancelled.push(rec.engagementId);
      }
      await this.deps.store.setDispatchLock(
        `budget_hard_cap: project spend ${totalSpent}¢ >= cap ${budget.hardCapCents}¢`,
        this.now(),
        budget.hardCapCents,
      );
      await this.deps.store.appendDecision({
        kind: "budget",
        event: {
          kind: "hard_cap",
          scope: "project",
          spentCents: totalSpent,
          capCents: budget.hardCapCents,
          cancelled,
          at: this.now(),
        },
      });
      for (const target of await this.projectNoticeTargets()) {
        await this.deps.substrate.comment(
          target,
          `Budget hard cap reached: project spend ${totalSpent}¢ >= cap ${budget.hardCapCents}¢. ` +
            `In-flight work was cancelled and dispatch is locked. ` +
            `To resume: raise the hard cap in configuration and restart the conductor.`,
        );
      }
      return;
    }

    if (totalSpent >= budget.softCapCents) {
      const warned = decisions.some(
        (d) => d.kind === "budget" && d.event.kind === "soft_cap" && d.event.scope === "project",
      );
      if (warned) return;
      await this.deps.store.appendDecision({
        kind: "budget",
        event: { kind: "soft_cap", scope: "project", spentCents: totalSpent, capCents: budget.softCapCents, at: this.now() },
      });
      for (const target of await this.projectNoticeTargets()) {
        await this.deps.substrate.comment(
          target,
          `Budget soft cap: project spend ${totalSpent}¢ has crossed the ${budget.softCapCents}¢ warning line (hard cap ${budget.hardCapCents}¢).`,
        );
      }
    }
  }

  /**
   * The kill-switch (D11 CLI scope, `guild kill`): lock FIRST — nothing new
   * can spend even if a later step fails — then cancel every spending
   * engagement (substrate cancel kills the agent process, P4/P10). The lock
   * records the hard cap in force so the budget sweep can never self-release it
   * (A1) — recovery is the same deliberate raise-the-cap-and-restart as the
   * budget lock (D12), never automatic.
   *
   * The cap is read from the store's persisted enforced cap (written by the
   * RUNNING conductor at startup), NOT this process's config: `guild kill` is a
   * separate process whose env may have drifted from the live conductor's frozen
   * config, and a lower cap here would let the conductor's stale-higher cap
   * self-release the lock (A1 verify finding). Config is only the fallback for
   * an in-process caller with no enforced cap persisted (unit tests). With no
   * enforced cap and no budget, no cap is recorded and the lock never
   * sweep-releases.
   */
  emergencyStop(): Promise<void> {
    return this.serialize(async () => {
      if (!(await this.deps.store.getDispatchLock())) {
        const capCents = (await this.deps.store.getEnforcedHardCap()) ?? this.config.projectBudget?.hardCapCents;
        await this.deps.store.setDispatchLock("kill_switch: operator emergency stop", this.now(), capCents ?? undefined);
      }
      for (const rec of await this.deps.store.listEngagements()) {
        if (SPENDING.has(rec.state)) await this.cancelEngagement(rec, "operator");
      }
    });
  }

  /**
   * Where project-level budget notices land: EVERY active run's idea ticket
   * (#12) — under concurrent ideas a single arbitrary target left the other
   * operators' surfaces silent. Deduped by ref; directly-adopted runs have no
   * idea ticket and are skipped, as before.
   */
  private async projectNoticeTargets(): Promise<WorkItemRef[]> {
    const seen = new Set<string>();
    const targets: WorkItemRef[] = [];
    for (const run of await this.deps.store.listPlanRuns()) {
      if (run.status !== "active" || !run.ideaItem) continue;
      const key = `${run.ideaItem.substrate} ${run.ideaItem.externalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(run.ideaItem);
    }
    return targets;
  }

  // ------------------------------------------------------- event routing

  private async routeEvent(ev: SubstrateEvent): Promise<void> {
    if (ev.kind === "item_created") return this.onItemCreated(ev);
    if (ev.kind === "lane_moved") return this.onLaneMoved(ev);
    if (ev.kind === "status") return this.onStatus(ev);
    if (ev.kind === "comment") return this.onComment(ev);
  }

  // ------------------------------------------------ idea detection (D12)

  private async onItemCreated(ev: Extract<SubstrateEvent, { kind: "item_created" }>): Promise<void> {
    if (ev.createdBy !== "operator") return;
    // the event is the trigger; the snapshot read is the truth (marker check)
    const snap = await this.deps.substrate.getWorkItem(ev.item);
    await this.maybeAdoptIdea(snap);
  }

  /** an idea = operator-authored, marker-less, live, and not yet answered */
  private async maybeAdoptIdea(snap: WorkItemSnapshot): Promise<void> {
    if (snap.createdBy !== "operator" || snap.markerId) return;
    if (snap.lane === "cancelled" || snap.lane === "done") return;
    if (await this.deps.store.getPlanRun(snap.item.externalId)) return;

    const idea: Idea = { ideaId: snap.item.externalId, title: snap.title, body: snap.body };
    // the idea's template: directive picks the pipeline shape (M3); unknown
    // names degrade to standard inside the planner, which also renders the
    // warning into the first gate body
    const { template } = templateFor(idea.body);
    const run: PlanRunRecord = {
      planId: idea.ideaId,
      ideaItem: snap.item,
      stageIds: template.stages.map((kind) => `stg:${idea.ideaId}:${kind}`),
      status: "active",
    };
    await this.deps.store.savePlanRun(run);
    const gate = await this.openStage(run, 0, 1);
    if (gate) {
      await this.deps.substrate.comment(
        snap.item,
        `Guild proposes a ${run.stageIds.length}-stage delivery plan for this idea. ` +
          `Stage 1 (${stageKindOf(run.stageIds[0]!)}) awaits your approval on its plan ticket: ` +
          `move it to *Ready to work* to approve, comment \`amend: <note>\` on it to revise, ` +
          `or move it to *Cancelled* to reject.`,
      );
    }
  }

  /**
   * Derive, persist, gate, and post stage `index` of a run at planVersion.
   * Contract assembly (D12): floor checks ∪ the upstream handoff read from the
   * PRECEDING stage's validated SHA; priorDecisions carry every accepted
   * stage. Derivation inputs are read fresh — the idea body is re-read so
   * amendments see current text.
   */
  private async openStage(run: PlanRunRecord, index: number, planVersion: number): Promise<WorkItemRef | null> {
    const stageId = run.stageIds[index];
    if (!stageId) return null;
    const kind = stageKindOf(stageId);
    if (!run.ideaItem) return null; // directly-adopted runs post via postStageForApproval

    const ideaSnap = await this.deps.substrate.getWorkItem(run.ideaItem);
    const idea: Idea = { ideaId: run.planId, title: ideaSnap.title, body: ideaSnap.body };
    const amendments = await this.amendmentNotes(stageId);

    let upstream: { handoff: UpstreamHandoff | null; authoredBy: string } | undefined;
    const priorDecisions: string[] = [];
    if (index > 0) {
      const prevStageId = run.stageIds[index - 1]!;
      const prevKind = stageKindOf(prevStageId);
      let handoffRaw: string | null = null;
      for (let i = 0; i < index; i++) {
        const sha = await this.stageValidatedSha(run.stageIds[i]!);
        if (sha) priorDecisions.push(`${stageKindOf(run.stageIds[i]!)} accepted at ${sha}`);
        if (i === index - 1 && sha) {
          handoffRaw = await this.deps.source.readFile(this.config.repoUrl, sha, handoffPathFor(kind));
        }
      }
      upstream = { handoff: handoffRaw ? parseHandoffChecks(handoffRaw) : null, authoredBy: roleFor(prevKind) };
    }

    const { plan, warnings } = deriveStagePlan(
      idea,
      { projectId: this.config.projectScope, defaultPlanBudgetCents: this.config.defaultPlanBudgetCents },
      kind,
      planVersion,
      { amendments, ...(upstream ? { upstream } : {}), priorDecisions },
    );
    await this.deps.store.saveStagePlan(plan);
    return this.postGate(plan, warnings);
  }

  /** the accepted engagement's validated sha for a stage (latest plan version) */
  private async stageValidatedSha(stageId: string): Promise<string | null> {
    const plan = await this.deps.store.getLatestStagePlan(stageId);
    if (!plan) return null;
    for (const ep of plan.engagements) {
      const rec = await this.deps.store.getEngagement(ep.engagementId);
      if (rec?.state === "accepted" && rec.validatedSha) return rec.validatedSha;
    }
    return null;
  }

  /** every amendment note ever recorded for this stage, in trail order (D12) */
  private async amendmentNotes(stageId: string): Promise<string[]> {
    const decisions = await this.deps.store.listDecisions();
    return decisions
      .filter(
        (d): d is { kind: "gate"; decision: Extract<GateDecision, { kind: "amended" }> } =>
          d.kind === "gate" && d.decision.kind === "amended" && d.decision.stageId === stageId,
      )
      .map((d) => d.decision.note);
  }

  // ---------------------------------------------------------------- gate

  private gateMarker(stageId: string, planVersion: number): string {
    return `gate:${stageId}:v${planVersion}`;
  }

  /** whether this gate was fully posted (recorded only after its resting-lane set) */
  private async gatePosted(stageId: string, planVersion: number): Promise<boolean> {
    const decisions = await this.deps.store.listDecisions();
    return decisions.some(
      (d) => d.kind === "gate_posted" && d.stageId === stageId && d.planVersion === planVersion,
    );
  }

  /**
   * Post a stage plan as a gate ticket in waiting-for-feedback (D11: the
   * operator's lane move to ready-to-work IS the approval). Idempotent across
   * calls and restarts: the marker is the dedup key on the substrate itself.
   */
  private async postGate(plan: StagePlan, warnings: string[]): Promise<WorkItemRef> {
    const existing =
      (await this.deps.store.getGateTicket(plan.stageId, plan.planVersion)) ??
      (await this.deps.substrate.findWorkItem(this.gateMarker(plan.stageId, plan.planVersion)));
    if (existing) {
      await this.deps.store.saveGateTicket(plan.stageId, plan.planVersion, existing);
      await this.ensureEngagementsGated(plan);
      // Complete an interrupted post (A5b): gate_posted is only recorded AFTER
      // the resting-lane set, so its absence means the gate was created (landing
      // in the substrate's ready_to_work go-lane default) but never moved to
      // waiting_for_feedback. Reconcile would otherwise read that creation
      // artifact as an operator approval. Neutralize ONLY the go-lane default —
      // an operator who rejected during the crash window (an off-board lane) must
      // be honored, not clobbered — then record the post so a later genuine
      // approval (which always follows a completed post) is read as a go-signal.
      if (!(await this.gatePosted(plan.stageId, plan.planVersion))) {
        if ((await this.deps.substrate.getWorkItem(existing)).lane === "ready_to_work") {
          await this.deps.substrate.setLane(existing, "waiting_for_feedback");
        }
        await this.deps.store.appendDecision({
          kind: "gate_posted",
          stageId: plan.stageId,
          planVersion: plan.planVersion,
          at: this.now(),
        });
      }
      return existing;
    }

    const ticket = await this.deps.substrate.createTicket({
      markerId: this.gateMarker(plan.stageId, plan.planVersion),
      title: `Plan approval: ${plan.kind} stage (v${plan.planVersion})`,
      body: this.renderPlanBody(plan, warnings),
    });
    await this.deps.substrate.setLane(ticket, "waiting_for_feedback");
    await this.deps.store.saveGateTicket(plan.stageId, plan.planVersion, ticket);
    await this.deps.store.appendDecision({
      kind: "gate_posted",
      stageId: plan.stageId,
      planVersion: plan.planVersion,
      at: this.now(),
    });
    await this.ensureEngagementsGated(plan);
    return ticket;
  }

  private async onLaneMoved(ev: Extract<SubstrateEvent, { kind: "lane_moved" }>): Promise<void> {
    // conductor echoes are idempotent noise; agent moves are never forward
    // signals (D11: validation verdicts are the only forward path)
    if (ev.actor !== "operator") {
      // an "unknown"-actor move to a go/halt lane on a governance ticket is the
      // signature of a stale/empty operator allowlist silently dropping a real
      // operator move (D15) — surface it so the deadlock is never silent
      if (ev.actor === "unknown") await this.warnIfDroppedGovernanceMove(ev);
      return;
    }

    const gateKey = await this.deps.store.findGateTicketByItem(ev.item);
    if (gateKey) {
      if (ev.lane === "ready_to_work") return this.approveStage(gateKey, ev.at);
      if (ev.lane === "cancelled") return this.rejectStage(gateKey, ev.at);
      return;
    }

    const record = await this.findByItem(ev.item);
    if (!record) return;
    if (ev.lane === "done" && record.state === "validated") return this.accept(record);
    if (ev.lane === "cancelled") return this.cancelEngagement(record, "operator");
  }

  /**
   * D15 deadlock visibility: a fail-closed operator allowlist that is stale or
   * empty maps the operator's own board moves to "unknown", which the guard
   * above drops — silently freezing approvals, acceptance, cancel and reject.
   * Warn (never throw) when a dropped move targets a governance ticket in a
   * go/halt lane, so a misconfigured GUILD_OPERATOR_MEMBER_IDS is observable
   * rather than an invisible strand. Agent/conductor moves are expected and stay
   * quiet; only "unknown" reaches here.
   */
  private async warnIfDroppedGovernanceMove(ev: Extract<SubstrateEvent, { kind: "lane_moved" }>): Promise<void> {
    if (ev.lane !== "ready_to_work" && ev.lane !== "done" && ev.lane !== "cancelled") return;
    const gate = await this.deps.store.findGateTicketByItem(ev.item);
    const record = gate ? null : await this.findByItem(ev.item);
    if (gate || record) {
      console.warn(
        `[D15] ignored a non-attributed member move to "${ev.lane}" on governance item ${ev.item.externalId}: ` +
          "if this was the operator, GUILD_OPERATOR_MEMBER_IDS is stale/empty and board approvals are deadlocked",
      );
    }
  }

  /**
   * Idempotent by the store's first-writer-wins gate decision (#11). A loser
   * of the race acts on what actually STUCK: a re-driven approve resumes
   * dispatch only when the recorded decision is an approval — a stale approve
   * against a rejected gate does nothing (M2b verify finding).
   */
  private async approveStage(gateKey: GateTicketKey, at: string): Promise<void> {
    const plan = await this.deps.store.getLatestStagePlan(gateKey.stageId);
    if (!plan) return;
    const decision: GateDecision = {
      kind: "approved",
      stageId: gateKey.stageId,
      planVersion: gateKey.planVersion,
      by: "operator",
      at,
    };
    const outcome = applyGateDecision(plan, decision);
    if (outcome.kind !== "authorized") return; // stale gates authorize nothing (D6)
    if (await this.deps.store.recordGateDecision(decision)) {
      await this.deps.store.appendDecision({ kind: "gate", decision });
    } else {
      const recorded = await this.deps.store.getGateDecision(gateKey.stageId, gateKey.planVersion);
      if (recorded?.kind !== "approved" && recorded?.kind !== "auto_approved") return;
    }
    for (const ep of outcome.engagements) await this.dispatch(ep);
    const gate = await this.deps.store.getGateTicket(gateKey.stageId, gateKey.planVersion);
    if (gate) await this.deps.substrate.setLane(gate, "done");
  }

  private async rejectStage(gateKey: GateTicketKey, at: string): Promise<void> {
    const plan = await this.deps.store.getLatestStagePlan(gateKey.stageId);
    if (!plan) return;
    const decision: GateDecision = {
      kind: "rejected",
      stageId: gateKey.stageId,
      planVersion: gateKey.planVersion,
      note: "operator moved the gate ticket off-board",
      at,
    };
    if (applyGateDecision(plan, decision).kind !== "rejected") return;
    if (await this.deps.store.recordGateDecision(decision)) {
      await this.deps.store.appendDecision({ kind: "gate", decision });
    } else {
      // a late reject against a gate that was actually APPROVED must be inert
      // — the unconditional loser path stranded live runs (M2b verify finding)
      const recorded = await this.deps.store.getGateDecision(gateKey.stageId, gateKey.planVersion);
      if (recorded?.kind !== "rejected") return;
    }
    for (const ep of plan.engagements) {
      const rec = await this.deps.store.getEngagement(ep.engagementId);
      if (!rec || rec.state !== "gated") continue;
      const updated = await this.applyTransition(rec, { kind: "gate_rejected" }, "stage rejected at the gate");
      if (updated) {
        await this.deps.store.appendDecision({
          kind: "termination",
          terminated: { engagementId: ep.engagementId, finalState: "cancelled", reason: "stage_rejected", at },
        });
      }
    }
    // a rejected stage closes its whole run (D12: revision-before-approval is
    // the amendment path; a new idea is a new ticket)
    const run = await this.runContaining(gateKey.stageId);
    if (run && run.status === "active") {
      await this.deps.store.savePlanRun({ ...run, status: "rejected" });
      if (run.ideaItem) {
        await this.deps.substrate.comment(
          run.ideaItem,
          `The ${stageKindOf(gateKey.stageId)} stage plan was rejected — this plan is closed. Open a new idea ticket to try a different framing.`,
        );
      }
    }
  }

  /**
   * Amendment (D12): an operator comment starting "amend" on an undecided
   * gate ticket re-derives the stage from the CURRENT idea body plus every
   * note so far, bumps planVersion, and re-gates. Contracts mirror D6
   * immutability: nothing dispatched ever changes.
   */
  private async onGateComment(
    gateKey: GateTicketKey,
    ev: Extract<SubstrateEvent, { kind: "comment" }>,
  ): Promise<void> {
    if (!isAmendNote(ev.body)) return;
    await this.applyGateAmend(gateKey, ev.body.trim(), ev.at);
  }

  /**
   * The amendment application shared by the live comment path and the
   * reconcile recovery path (#12). recordGateDecision's first-writer-wins key
   * makes replays no-ops; returns whether a re-gate actually happened.
   */
  private async applyGateAmend(gateKey: GateTicketKey, note: string, at: string): Promise<boolean> {
    const plan = await this.deps.store.getStagePlan(gateKey.stageId, gateKey.planVersion);
    const latest = await this.deps.store.getLatestStagePlan(gateKey.stageId);
    if (!plan || !latest || latest.planVersion !== gateKey.planVersion) return false; // stale gate
    const run = await this.runContaining(gateKey.stageId);
    if (!run || run.status !== "active" || !run.ideaItem) return false;

    const decision: GateDecision = {
      kind: "amended",
      stageId: gateKey.stageId,
      planVersion: gateKey.planVersion,
      note,
      at,
    };
    if (!(await this.deps.store.recordGateDecision(decision))) return false; // already decided
    await this.deps.store.appendDecision({ kind: "gate", decision });
    await this.driveAmendTail(gateKey, at);
    return true;
  }

  /**
   * Everything an amendment does AFTER its decision is durably recorded —
   * split out because a crash inside this tail leaves the first-writer-wins
   * decision blocking every replay (#12 review): reconcile detects "amended
   * at the latest version, no successor plan" and re-drives this, idempotent
   * throughout (transition CAS, idempotent lane set, deterministic re-derive).
   */
  private async driveAmendTail(gateKey: GateTicketKey, at: string): Promise<void> {
    const plan = await this.deps.store.getStagePlan(gateKey.stageId, gateKey.planVersion);
    const run = await this.runContaining(gateKey.stageId);
    if (!plan || !run || run.status !== "active") return;

    // supersede the un-dispatched engagements of the amended version
    for (const ep of plan.engagements) {
      const rec = await this.deps.store.getEngagement(ep.engagementId);
      if (rec?.state === "gated") {
        const superseded = await this.applyTransition(
          rec,
          { kind: "cancelled", reason: "plan_amended" },
          `superseded by v${gateKey.planVersion + 1}`,
        );
        if (superseded) {
          await this.deps.store.appendDecision({
            kind: "termination",
            terminated: {
              engagementId: ep.engagementId,
              finalState: "cancelled",
              reason: "plan_amended",
              at,
            },
          });
        }
      }
    }
    const oldGate = await this.deps.store.getGateTicket(gateKey.stageId, gateKey.planVersion);
    if (oldGate) await this.deps.substrate.setLane(oldGate, "cancelled");

    const index = run.stageIds.indexOf(gateKey.stageId);
    await this.openStage(run, index, gateKey.planVersion + 1);
  }

  // ------------------------------------------------------------ dispatch

  /**
   * The dispatch saga (D6 runtime semantics): intent row first, then every
   * effect guarded — mint is idempotent, bind precedes item creation
   * (assignment dispatches immediately, P6 — a late bind leaks spend onto
   * the previous key), findWorkItem before create. A crash resumes; it never
   * re-dispatches blind. A budget dispatch lock (D12 watchdog) refuses new
   * spend before the intent row exists.
   */
  private async dispatch(ep: EngagementPlan): Promise<void> {
    const rec = await this.deps.store.getEngagement(ep.engagementId);
    if (!rec || rec.state !== "gated") return;
    if (await this.deps.store.getDispatchLock()) return; // hard-capped: no new spend

    await this.deps.store.recordDispatchIntent(ep.engagementId, this.now());
    const key = await this.deps.gateway.mintKey(ep.engagementId, ep.budgetCents);
    await this.deps.substrate.bindEngagementKey(ep.role, key.key);
    const item =
      (await this.deps.substrate.findWorkItem(ep.engagementId)) ??
      (await this.deps.substrate.createWorkItem({
        engagementId: ep.engagementId,
        role: ep.role,
        title: ep.title,
        brief: ep.brief,
      }));
    await this.deps.substrate.setLane(item, "ready_to_work");
    const updated = await this.applyTransition({ ...rec, item }, { kind: "dispatch_succeeded" }, "gate approved");
    if (updated) {
      await this.deps.store.appendDecision({
        kind: "dispatch",
        outcome: { kind: "dispatched", engagementId: ep.engagementId, workItem: item, at: this.now() },
      });
    }
  }

  // ------------------------------------------------------------ lifecycle

  private async onStatus(ev: Extract<SubstrateEvent, { kind: "status" }>): Promise<void> {
    const record = await this.findByItem(ev.item);
    if (!record) return;

    if (ev.status === "running") {
      const updated = await this.applyTransition(record, { kind: "work_started" }, "task running");
      if (updated) await this.setEngagementLane(updated);
      return;
    }
    if (ev.status === "done") return this.onReported(record);
  }

  private async onReported(record: EngagementRecord): Promise<void> {
    const reported = await this.applyTransition(record, { kind: "reported" }, "agent reported done");
    if (!reported) return;
    await this.setEngagementLane(reported);
    await this.judgeReported(reported);
  }

  /**
   * Judge a reported engagement — callable both after the report transition
   * and from reconcile, so a validator_error is genuinely retryable (D6):
   * the engagement stays in reported and the next reconcile re-judges the
   * same SHA-pinned input.
   */
  private async judgeReported(record: EngagementRecord): Promise<void> {
    let reported = record;
    const snapshot = await this.deps.substrate.getWorkItem(reported.item!);
    const resolved = await this.resolveReport(reported, snapshot);
    // remember the best-known branch even on a hollow report: whether the
    // daemon reuses attempt 1's branch or mints a new one per task, a later
    // rework must be resolvable against every hint this engagement has named
    const bestBranch = resolved?.branch ?? snapshot.report?.branchHint ?? reported.lastBranch;
    const attemptId = snapshot.report?.attemptId;
    if (resolved || bestBranch !== reported.lastBranch || attemptId !== reported.lastJudgedAttempt) {
      reported = {
        ...reported,
        ...(bestBranch ? { lastBranch: bestBranch } : {}),
        ...(resolved ? { lastJudgedSha: resolved.sha } : {}),
        ...(attemptId ? { lastJudgedAttempt: attemptId } : {}),
      };
      await this.deps.store.saveEngagement(reported);
    }
    const verdict = await this.judge(reported, snapshot, resolved);
    await this.deps.store.appendDecision({ kind: "verdict", engagementId: reported.engagementId, verdict });

    if (verdict.outcome === "validator_error") {
      // infrastructure fault: the engagement stays reported; the work is
      // never bounced for the validator's own failure (D6)
      await this.applyTransition(reported, { kind: "validator_errored" }, "validator infrastructure fault");
      return;
    }

    if (verdict.outcome === "passed") {
      const validated = await this.applyTransition(
        { ...reported, validatedSha: verdict.commitSha },
        { kind: "verdict_passed" },
        "contract validated",
      );
      if (validated) {
        await this.setEngagementLane(validated);
        await this.deps.substrate.comment(
          validated.item!,
          `Contract ${verdict.contractId} v${verdict.contractVersion} PASSED at ${verdict.commitSha}. Awaiting operator acceptance (move this ticket to Done).`,
        );
      }
      return;
    }

    // failed → bounce, or escalate once the bounce budget is spent
    const next = await this.applyTransition(reported, { kind: "verdict_failed" }, "contract failed");
    if (!next) return;
    if (next.state === "bounced") {
      await this.deps.substrate.requestRework(next.item!, verdict);
      await this.setEngagementLane(next);
      await this.deps.store.appendDecision({
        kind: "bounce",
        outcome: { engagementId: next.engagementId, bounceCount: next.bounceCount, verdict, at: this.now() },
      });
      return;
    }
    // escalated: spend stops now; the ticket stays visible for the operator —
    // close/lock happens when the operator resolves (cancel or rescope)
    const spentCents = await this.captureSpend(next);
    await this.deps.gateway.revokeKey(next.engagementId);
    await this.setEngagementLane(next);
    await this.deps.substrate.comment(
      next.item!,
      `Escalated: contract failed after ${MAX_BOUNCES} bounces. Operator action required — cancel this ticket or rescope the engagement.`,
    );
    await this.deps.store.appendDecision({
      kind: "termination",
      terminated: {
        engagementId: next.engagementId,
        finalState: "escalated",
        reason: "bounce_limit",
        ...(spentCents !== undefined ? { spentCents } : {}),
        at: this.now(),
      },
    });
  }

  /**
   * The ONE branch-head resolution per report (D6): the fresh hint first,
   * then the branch that resolved last time — the daemon mints a new hint per
   * task (P7) while the bounce instruction sends fixes to the delivery branch.
   */
  private async resolveReport(
    record: EngagementRecord,
    snapshot: WorkItemSnapshot,
  ): Promise<{ branch: string; sha: string } | null> {
    const candidates = [...new Set([snapshot.report?.branchHint, record.lastBranch].filter((b): b is string => !!b))];
    for (const branch of candidates) {
      const sha = await this.deps.source.resolveRemoteSha(this.config.repoUrl, branch);
      if (sha) return { branch, sha };
    }
    return null;
  }

  /** no resolvable branch → the hollow-completion verdict, no validator run */
  private async judge(
    record: EngagementRecord,
    snapshot: WorkItemSnapshot,
    resolved: { branch: string; sha: string } | null,
  ): Promise<ContractVerdict> {
    const contract = await this.contractFor(record);
    if (!resolved) {
      const branch = snapshot.report?.branchHint;
      const detail = branch
        ? `engagement branch "${branch}" does not exist on the remote — nothing was pushed`
        : "the report names no engagement branch — nothing was pushed";
      return {
        engagementId: record.engagementId,
        contractId: contract.contractId,
        contractVersion: contract.version,
        commitSha: "",
        outcome: "failed",
        checkedAt: this.now(),
        results: contract.checks.map((check) => ({ check, outcome: "failed" as const, detail })),
      };
    }
    return this.deps.validator.validate({
      engagementId: record.engagementId,
      contract,
      repoUrl: this.config.repoUrl,
      commitSha: resolved.sha,
    });
  }

  // ----------------------------------------------------- accept / cancel

  /**
   * The engagement's final spend reading, captured BEFORE revocation deletes
   * the key (revoked keys are unreadable — live finding, M2b): project
   * accounting sums live keys plus these termination-entry recordings.
   */
  private async finalSpend(engagementId: string): Promise<number | undefined> {
    // null = the key definitively does not exist. A TRANSIENT failure throws
    // through (#12 review): the caller's termination effects abort before
    // revocation, so the re-drive retries against the still-live key instead
    // of appending a spendless entry that loses the reading forever.
    return (await this.deps.gateway.getSpend(engagementId))?.spentCents;
  }

  /**
   * Read the final spend and persist it on the (post-transition) record
   * BEFORE the caller revokes the key (#12): a crash between revocation and
   * the termination-entry append then recovers the reading from the record
   * instead of losing it to the deleted key. CAS against the record's own
   * state — a concurrent writer's transition must not be clobbered by this
   * accounting annotation.
   */
  private async captureSpend(record: EngagementRecord): Promise<number | undefined> {
    const spentCents = await this.finalSpend(record.engagementId);
    if (spentCents !== undefined) {
      await this.deps.store.saveEngagementIf({ ...record, terminalSpendCents: spentCents }, record.state);
    }
    return spentCents;
  }

  private async accept(record: EngagementRecord): Promise<void> {
    if (!record.item || !record.validatedSha) return;
    // merge first: a fast-forward failure leaves the engagement validated and
    // retryable, never half-terminated
    await this.deps.source.fastForward(this.config.repoUrl, this.config.targetBranch, record.validatedSha);
    const accepted = await this.applyTransition(record, { kind: "accepted" }, "operator accepted");
    if (!accepted) return;
    const spentCents = await this.captureSpend(accepted);
    await this.deps.gateway.revokeKey(accepted.engagementId);
    await this.deps.substrate.close(record.item);
    await this.deps.store.appendDecision({
      kind: "termination",
      terminated: {
        engagementId: record.engagementId,
        finalState: "accepted",
        ...(spentCents !== undefined ? { spentCents } : {}),
        at: this.now(),
      },
    });
    // stage sequencing (D12): an acceptance may complete its stage
    await this.advancePlanRuns();
  }

  private async cancelEngagement(record: EngagementRecord, reason: "operator" | "budget_hard_cap"): Promise<void> {
    const cancelled = await this.applyTransition(record, { kind: "cancelled", reason }, `cancelled: ${reason}`);
    if (!cancelled) return;
    if (cancelled.item) await this.deps.substrate.cancel(cancelled.item, reason);
    const spentCents = await this.captureSpend(cancelled);
    await this.deps.gateway.revokeKey(cancelled.engagementId);
    // close in the cancelled lane, never Done — this is not accepted work (B9)
    if (cancelled.item) await this.deps.substrate.close(cancelled.item, "cancelled");
    await this.deps.store.appendDecision({
      kind: "termination",
      terminated: {
        engagementId: record.engagementId,
        finalState: "cancelled",
        reason,
        ...(spentCents !== undefined ? { spentCents } : {}),
        at: this.now(),
      },
    });
  }

  // -------------------------------------------------- stage sequencing

  /**
   * Advance every active run (idempotent, reconcile-callable): the first
   * incomplete stage either already has a posted plan (waiting on its gate or
   * its work) or is opened now — which only happens once every earlier stage
   * is accepted. A run with no incomplete stage completes: idea ticket → Done.
   */
  private async advancePlanRuns(): Promise<void> {
    for (const run of await this.deps.store.listPlanRuns()) {
      if (run.status !== "active") continue;
      let advanced = false;
      for (const [index, stageId] of run.stageIds.entries()) {
        const plan = await this.deps.store.getLatestStagePlan(stageId);
        if (!plan) {
          await this.openStage(run, index, 1);
          advanced = true;
          break;
        }
        if (!(await this.stageComplete(plan))) {
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        await this.deps.store.savePlanRun({ ...run, status: "completed" });
        if (run.ideaItem) {
          await this.deps.substrate.comment(
            run.ideaItem,
            "Every stage of this plan is accepted — delivery complete. The decision trail is queryable in Guild's decisions table.",
          );
          await this.deps.substrate.setLane(run.ideaItem, "done");
        }
      }
    }
  }

  private async stageComplete(plan: StagePlan): Promise<boolean> {
    for (const ep of plan.engagements) {
      const rec = await this.deps.store.getEngagement(ep.engagementId);
      if (rec?.state !== "accepted") return false;
    }
    return plan.engagements.length > 0;
  }

  private async runContaining(stageId: string): Promise<PlanRunRecord | null> {
    for (const run of await this.deps.store.listPlanRuns()) {
      if (run.stageIds.includes(stageId)) return run;
    }
    return null;
  }

  // ------------------------------------------------------------ blockers

  private async onComment(ev: Extract<SubstrateEvent, { kind: "comment" }>): Promise<void> {
    const gateKey = await this.deps.store.findGateTicketByItem(ev.item);
    if (gateKey) {
      if (ev.actor === "operator") await this.onGateComment(gateKey, ev);
      return;
    }

    const record = await this.findByItem(ev.item);
    if (!record) return;

    if (ev.actor === "agent" && record.state === "working") {
      // completion race: the agent's final output arrives as a comment in the
      // same breath as task:completed — a terminal snapshot means this is the
      // report, not a question (the status handler owns that path)
      const snapshot = await this.deps.substrate.getWorkItem(ev.item);
      if (TERMINAL_WORK.has(snapshot.status)) return;
      const blocked = await this.applyTransition(record, { kind: "question_raised" }, "agent raised a question");
      if (blocked) await this.setEngagementLane(blocked);
      return;
    }
    if (ev.actor === "operator" && record.state === "blocked") {
      // the substrate routes the reply to the asking agent (P5); Guild only
      // returns the ticket to work
      const resumed = await this.applyTransition(record, { kind: "question_answered" }, "operator answered");
      if (resumed) await this.setEngagementLane(resumed);
    }
  }

  // -------------------------------------------------------- reconcile

  private async reconcileUnsafe(): Promise<void> {
    const errors: string[] = [];
    // per-item isolation (B2): a permanent fault on one item — e.g. a human
    // pushed to main so accept() can't fast-forward — must not abort the whole
    // pass and freeze every other engagement. Each item runs under guard; the
    // aggregate is thrown at the end so the fault stays visible in the log.
    const guard = async (label: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    // 1. ideas that appeared while down (reads are the idea truth path too)
    for (const snap of await this.deps.substrate.listWorkItems(this.config.projectScope)) {
      await guard(`adopt ${snap.item.externalId}`, () => this.maybeAdoptIdea(snap));
    }

    // 2. ensure every active run's current stage is posted; re-surface gate moves
    //    made while down. A gate ticket is conductor-authored (A5a) and postGate
    //    re-asserts the resting lane for a not-yet-fully-posted gate (A5b). A
    //    go-lane found on a posted gate carries NO actor in the snapshot, so it
    //    could be the operator OR an agent/forged move (A5c) — reconcile must not
    //    APPROVE on it (approval mints keys and dispatches: it spends). D15 (c):
    //    re-assert the resting lane so the move is visible and inert; the operator
    //    re-moves to trigger the live, operator-attributed approval. Rejection is
    //    a HALT, not an advance, so it is still honored here.
    for (const run of await this.deps.store.listPlanRuns()) {
      if (run.status !== "active") continue;
      await guard(`stage-gate ${run.planId}`, async () => {
        for (const [index, stageId] of run.stageIds.entries()) {
          const plan = await this.deps.store.getLatestStagePlan(stageId);
          if (!plan) {
            if (run.ideaItem) await this.openStage(run, index, 1);
            break;
          }
          if (await this.stageComplete(plan)) continue;
          // #12 review: a crash inside the amend tail leaves the amended
          // decision recorded at the (still-)latest version with no successor
          // plan — first-writer-wins then blocks every comment replay. Detect
          // and re-drive the tail before anything else touches this gate.
          const recorded = await this.deps.store.getGateDecision(stageId, plan.planVersion);
          if (recorded?.kind === "amended") {
            await this.driveAmendTail({ stageId, planVersion: plan.planVersion }, recorded.at);
            break;
          }
          await this.postGate(plan, []);
          const gate = await this.deps.store.getGateTicket(plan.stageId, plan.planVersion);
          if (gate) {
            const snap = await this.deps.substrate.getWorkItem(gate);
            const gateKey = { stageId: plan.stageId, planVersion: plan.planVersion };
            if (snap.lane === "cancelled") {
              await this.rejectStage(gateKey, this.now());
              break;
            }
            // Amend-while-down recovery (#12): operator `amend:` comments on
            // the CURRENT gate ticket are by construction unprocessed — a live
            // application supersedes the ticket. Oldest first; each note
            // re-derives against the then-latest version, so several downtime
            // notes stack exactly as they would have live. Amend WINS over a
            // downtime go-lane (operator decision 2026-08-11, extending the
            // D15c reject-beats-stale-approve stance): the re-gate posts
            // v+1 in waiting-for-feedback and the stale move dies with the
            // superseded ticket. (A crash mid-loop leaves later notes on the
            // superseded ticket — visible in its body, reapplied by nobody;
            // accepted residual, the gate body shows what was folded.)
            let amended = false;
            try {
              const pending = (await this.deps.substrate.listComments(gate))
                .filter((c) => c.actor === "operator" && isAmendNote(c.body))
                .sort((a, b) => a.at.localeCompare(b.at));
              for (const c of pending) {
                const current = await this.deps.store.getLatestStagePlan(stageId);
                if (!current) break;
                const applied = await this.applyGateAmend(
                  { stageId, planVersion: current.planVersion },
                  c.body.trim(),
                  c.at,
                );
                amended = amended || applied;
              }
            } catch (e) {
              // a broken comments read must not skip the D15c go-lane
              // neutralization below (#12 review) — the scan retries next pass
              errors.push(`amend-scan ${stageId}: ${e instanceof Error ? e.message : String(e)}`);
            }
            if (!amended && snap.lane === "ready_to_work") {
              await this.deps.substrate.setLane(gate, "waiting_for_feedback");
            }
          }
          break;
        }
      });
    }

    // 3. crashed dispatch sagas: intent persisted, record still gated
    const intents = await this.deps.store.listDispatchIntents();
    for (const engagementId of intents) {
      await guard(`dispatch ${engagementId}`, async () => {
        const rec = await this.deps.store.getEngagement(engagementId);
        if (rec?.state !== "gated") return;
        const ep = await this.engagementPlanFor(rec);
        if (ep) await this.dispatch(ep);
      });
    }

    // 4. engagement drift against substrate reads
    for (const rec of await this.deps.store.listEngagements()) {
      if (!rec.item) continue;
      await guard(`drift ${rec.engagementId}`, async () => {
        const snap = await this.deps.substrate.getWorkItem(rec.item!);
        if (snap.status === "running" && (rec.state === "dispatched" || rec.state === "bounced")) {
          const updated = await this.applyTransition(rec, { kind: "work_started" }, "reconciled: task running");
          if (updated) await this.setEngagementLane(updated);
        } else if (
          snap.status === "done" &&
          (rec.state === "dispatched" || rec.state === "working" || rec.state === "blocked")
        ) {
          let current = rec;
          if (rec.state === "dispatched") {
            current =
              (await this.applyTransition(rec, { kind: "work_started" }, "reconciled: task ran while down")) ?? rec;
          }
          await this.onReported(current);
        } else if (snap.status === "done" && rec.state === "reported") {
          // stranded by a validator_error (or a crash mid-judgment): re-judge —
          // the input is the same SHA-pinned report, so retry is idempotent
          await this.judgeReported(rec);
        } else if (snap.status === "done" && rec.state === "bounced") {
          // a bounced engagement's snapshot stays "done" from the judged run
          // until the rework task starts. Rework signals (#11): a NEW commit at
          // the head, OR a NEW attempt whose head has not moved — the hollow
          // rework — which must be judged (and bounced again), never stranded.
          const resolved = await this.resolveReport(rec, snap);
          const newCommit = resolved && resolved.sha !== rec.lastJudgedSha;
          const newAttempt =
            snap.report?.attemptId !== undefined && snap.report.attemptId !== rec.lastJudgedAttempt;
          if (newCommit || newAttempt) {
            const started = await this.applyTransition(rec, { kind: "work_started" }, "reconciled: rework delivered");
            if (started) await this.onReported(started);
          }
        } else if (rec.state === "validated" && snap.lane === "done") {
          // D15 (c): a done lane on reconcile carries no actor — it may be an
          // agent/forged move, not the operator (A5c). Acceptance fast-forwards
          // the validated SHA, so it happens only on the live operator move.
          // Re-assert the resting lane (validated → waiting_for_feedback) so the
          // pending acceptance is visible; the operator re-moves to Done to accept.
          await this.setEngagementLane(rec);
        }
      });
    }

    // 5. terminal-effect re-drive (#11): a crash between the terminal
    //    transition and its effects leaves a terminal record with no
    //    termination entry — re-run the (idempotent) effects and append it
    const decisions = await this.deps.store.listDecisions();
    for (const rec of await this.deps.store.listEngagements()) {
      if (!TERMINAL_STATES.has(rec.state)) continue;
      await guard(`terminal ${rec.engagementId}`, async () => {
        const settled = decisions.some(
          (d) =>
            d.kind === "termination" &&
            d.terminated.engagementId === rec.engagementId &&
            d.terminated.finalState === rec.state,
        );
        if (settled) return;
        // live reading wins (crash happened before revocation); the persisted
        // terminalSpendCents recovers the crash-after-revocation window (#12)
        const spentCents = (await this.captureSpend(rec)) ?? rec.terminalSpendCents;
        await this.deps.gateway.revokeKey(rec.engagementId);
        const reason =
          rec.state === "cancelled"
            ? this.recoverCancelReason(decisions, rec.engagementId)
            : rec.state === "escalated"
              ? "bounce_limit"
              : undefined;
        if (rec.state === "cancelled" && rec.item)
          await this.deps.substrate.cancel(rec.item, reason as CancellationReason);
        // accepted → done, cancelled → cancelled: laneFor projects the terminal
        // state onto the right board lane so a re-driven cancel isn't mislabelled (B9)
        if (rec.state !== "escalated" && rec.item) await this.deps.substrate.close(rec.item, laneFor(rec.state));
        await this.deps.store.appendDecision({
          kind: "termination",
          terminated: {
            engagementId: rec.engagementId,
            finalState: rec.state as "accepted" | "cancelled" | "escalated",
            ...(reason ? { reason: reason as CancellationReason } : {}),
            ...(spentCents !== undefined ? { spentCents } : {}),
            at: this.now(),
          },
        });
      });
    }

    // 6. stage sequencing: acceptances that landed above may complete stages
    await guard("advancePlanRuns", () => this.advancePlanRuns());

    // per-item faults were isolated above; surface them as one aggregate so the
    // pass still signals trouble (guild-conductor logs + redacts it) (B2)
    if (errors.length > 0) {
      throw new Error(`reconcile completed with ${errors.length} item error(s): ${errors.join("; ")}`);
    }
  }

  /** the cancellation reason lives in the transition cause when the entry is missing */
  private recoverCancelReason(
    decisions: Awaited<ReturnType<GovernanceStore["listDecisions"]>>,
    engagementId: string,
  ): CancellationReason {
    for (let i = decisions.length - 1; i >= 0; i--) {
      const d = decisions[i]!;
      if (d.kind !== "transition" || d.engagementId !== engagementId || d.to !== "cancelled") continue;
      if (d.cause.startsWith("cancelled: ")) return d.cause.slice("cancelled: ".length) as CancellationReason;
      if (d.cause.includes("stage rejected")) return "stage_rejected";
      if (d.cause.startsWith("superseded")) return "plan_amended";
    }
    return "operator";
  }

  // ------------------------------------------------------------- helpers

  private async ensureEngagementsGated(plan: StagePlan): Promise<void> {
    for (const ep of plan.engagements) {
      let rec = await this.deps.store.getEngagement(ep.engagementId);
      if (!rec) {
        rec = {
          engagementId: ep.engagementId,
          stageId: plan.stageId,
          planVersion: plan.planVersion,
          state: "planned",
          bounceCount: 0,
        };
        await this.deps.store.saveEngagement(rec);
      }
      if (rec.state === "planned") {
        await this.applyTransition(rec, { kind: "posted_for_approval" }, "stage posted for approval");
      }
    }
  }

  private async engagementPlanFor(rec: EngagementRecord): Promise<EngagementPlan | null> {
    const plan = await this.deps.store.getStagePlan(rec.stageId, rec.planVersion);
    return plan?.engagements.find((e) => e.engagementId === rec.engagementId) ?? null;
  }

  private async contractFor(rec: EngagementRecord) {
    const ep = await this.engagementPlanFor(rec);
    if (!ep) throw new Error(`engagement ${rec.engagementId} has no persisted plan (${rec.stageId} v${rec.planVersion})`);
    return ep.brief.contract;
  }

  private async findByItem(item: WorkItemRef): Promise<EngagementRecord | null> {
    const all = await this.deps.store.listEngagements();
    return all.find((r) => r.item?.externalId === item.externalId) ?? null;
  }

  /** project the engagement's state onto its ticket's lane (D11) */
  private async setEngagementLane(record: EngagementRecord): Promise<void> {
    if (record.item) await this.deps.substrate.setLane(record.item, laneFor(record.state));
  }

  /**
   * Apply a domain event through the store's state CAS (#11); a rejected
   * transition — or a lost race — returns null: terminal absorption (the
   * first persisted decision wins) and illegal moves are the caller's signal
   * to ignore, exactly as the termination protocol demands.
   */
  private async applyTransition(
    record: EngagementRecord,
    event: EngagementEvent,
    cause: string,
  ): Promise<EngagementRecord | null> {
    const result = transition(record, event);
    if (!result.ok) return null;
    const updated: EngagementRecord = { ...record, ...result.engagement };
    if (!(await this.deps.store.saveEngagementIf(updated, record.state))) return null;
    await this.deps.store.appendDecision({
      kind: "transition",
      engagementId: record.engagementId,
      from: record.state,
      to: updated.state,
      cause,
      at: this.now(),
    });
    return updated;
  }

  private renderCheck(check: ContractCheck): string {
    return check.kind === "artifact"
      ? `- artifact \`${check.path}\`${check.mustContain ? ` containing \`${check.mustContain}\`` : ""}`
      : `- command \`${check.run}\` exits ${check.expectExitCode} within ${check.timeoutSeconds}s`;
  }

  private renderPlanBody(plan: StagePlan, warnings: string[]): string {
    const lines = [
      `## Stage plan — ${plan.kind}`,
      "",
      plan.objective,
      "",
      `Plan version: ${plan.planVersion} · Stage budget: ${plan.budgetCents}¢`,
      "",
      "### Engagements",
      ...plan.engagements.flatMap((e) => [
        `- **${e.title}** (${e.role}, ${e.budgetCents}¢) — contract ${e.brief.contract.contractId} v${e.brief.contract.version} (authored by ${e.brief.contract.authoredBy})`,
        ...e.brief.contract.checks.map((c) => `  ${this.renderCheck(c)}`),
        // the WHOLE contract is what approval covers (D12) — upstream-authored
        // gherkin included, verbatim, so nothing reaches an agent unreviewed
        "",
        "  Acceptance criteria (gherkin, verbatim):",
        "  ```gherkin",
        ...e.brief.contract.gherkin.split("\n").map((line) => `  ${line}`),
        "  ```",
      ]),
      ...(warnings.length ? ["", "### Warnings", ...warnings.map((w) => `- ${w}`)] : []),
      "",
      "**To approve:** move this ticket to *Ready to work*. **To amend:** comment `amend: <note>` here. **To reject:** move it to *Cancelled*.",
    ];
    return lines.join("\n");
  }
}
