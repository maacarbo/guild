/**
 * The engagement conductor — the governed core loop of M2a (issue #2):
 * board gate → dispatch saga → SHA-pinned validation → bounce | accept →
 * termination protocol, with every transition appended to the decision trail.
 *
 * Zero discretion, full mechanics (D11): this class never invents work — it
 * only executes transitions a human-approved plan authorizes and a validated
 * contract permits. Operator lane moves are the only approvals; agent lane
 * moves are never forward signals; its own moves come back as attributed
 * echoes and are ignored.
 */

import type {
  ContractVerdict,
  EngagementPlan,
  ExecutionSubstrate,
  GateDecision,
  ModelGateway,
  StagePlan,
  SubstrateEvent,
  WorkItemRef,
  WorkItemSnapshot,
} from "@guild/shared";
import { MAX_BOUNCES } from "@guild/shared";
import { applyGateDecision } from "../domain/gate.js";
import { laneFor } from "../domain/lane.js";
import { transition, type EngagementEvent } from "../domain/engagement.js";
import type { EngagementRecord, GovernanceStore } from "../ports/governance-store.js";
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
}

const TERMINAL_WORK: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

export class Conductor {
  private readonly now: () => string;

  constructor(
    private readonly plan: StagePlan,
    private readonly deps: ConductorDeps,
    private readonly config: ConductorConfig,
  ) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private gateMarker(): string {
    return `gate:${this.plan.stageId}:v${this.plan.planVersion}`;
  }

  /**
   * Post the stage plan as a gate ticket in waiting-for-feedback (D11: the
   * operator's lane move to ready-to-work IS the approval). Idempotent across
   * calls and restarts: the marker is the dedup key on the substrate itself.
   */
  async postStageForApproval(): Promise<WorkItemRef> {
    const existing =
      (await this.deps.store.getGateTicket(this.plan.stageId, this.plan.planVersion)) ??
      (await this.deps.substrate.findWorkItem(this.gateMarker()));
    if (existing) {
      await this.deps.store.saveGateTicket(this.plan.stageId, this.plan.planVersion, existing);
      await this.ensureEngagementsGated();
      return existing;
    }

    const ticket = await this.deps.substrate.createTicket({
      markerId: this.gateMarker(),
      title: `Plan approval: ${this.plan.objective} (stage ${this.plan.stageId}, v${this.plan.planVersion})`,
      body: this.renderPlanBody(),
    });
    await this.deps.substrate.setLane(ticket, "waiting_for_feedback");
    await this.deps.store.saveGateTicket(this.plan.stageId, this.plan.planVersion, ticket);
    await this.deps.store.appendDecision({
      kind: "gate_posted",
      stageId: this.plan.stageId,
      planVersion: this.plan.planVersion,
      at: this.now(),
    });
    await this.ensureEngagementsGated();
    return ticket;
  }

  /** route one substrate event; unknown items and non-signals are ignored */
  async handleEvent(ev: SubstrateEvent): Promise<void> {
    if (ev.kind === "lane_moved") return this.onLaneMoved(ev);
    if (ev.kind === "status") return this.onStatus(ev);
    if (ev.kind === "comment") return this.onComment(ev);
  }

  /** event loop for live operation; unit tests drive handleEvent directly */
  async run(opts?: { signal?: AbortSignal }): Promise<void> {
    for await (const ev of this.deps.substrate.watch(this.config.projectScope, opts)) {
      await this.handleEvent(ev);
    }
  }

  /**
   * Recover from reads (the truth path): resume crashed dispatch sagas,
   * honor gate and acceptance moves the operator made while the conductor was
   * down, and catch up missed task transitions. Idempotent — a settled state
   * reconciles to zero new decisions. Attribution note: a gate ticket is
   * never assigned, and the conductor only ever moves it to done, so a go- or
   * off-board lane found on it can only be the operator's move (D11 fallback).
   */
  async reconcile(): Promise<void> {
    await this.postStageForApproval();

    // 1. crashed dispatch sagas: intent persisted, record still gated
    const intents = await this.deps.store.listDispatchIntents();
    for (const ep of this.plan.engagements) {
      if (!intents.includes(ep.engagementId)) continue;
      const rec = await this.deps.store.getEngagement(ep.engagementId);
      if (rec?.state === "gated") await this.dispatch(ep);
    }

    // 2. gate moves made while down
    const gate = await this.deps.store.getGateTicket(this.plan.stageId, this.plan.planVersion);
    if (gate) {
      const snap = await this.deps.substrate.getWorkItem(gate);
      if (snap.lane === "ready_to_work") await this.approveStage(this.now());
      else if (snap.lane === "cancelled") await this.rejectStage(this.now());
    }

    // 3. engagement drift against substrate reads
    for (const rec of await this.deps.store.listEngagements()) {
      if (!rec.item) continue;
      const snap = await this.deps.substrate.getWorkItem(rec.item);
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
        // until the rework task starts — only a NEW commit at the head is the
        // rework signal; the already-judged sha must not be judged again
        const resolved = await this.resolveReport(rec, snap);
        if (resolved && resolved.sha !== rec.lastJudgedSha) {
          const started = await this.applyTransition(rec, { kind: "work_started" }, "reconciled: rework delivered");
          if (started) await this.onReported(started);
        }
      } else if (rec.state === "validated" && snap.lane === "done") {
        await this.accept(rec);
      }
    }
  }

  // ---------------------------------------------------------------- gate

  private async onLaneMoved(ev: Extract<SubstrateEvent, { kind: "lane_moved" }>): Promise<void> {
    // conductor echoes are idempotent noise; agent moves are never forward
    // signals (D11: validation verdicts are the only forward path)
    if (ev.actor !== "operator") return;

    const gate = await this.deps.store.getGateTicket(this.plan.stageId, this.plan.planVersion);
    if (gate && gate.externalId === ev.item.externalId) return this.onGateMoved(ev);

    const record = await this.findByItem(ev.item);
    if (!record) return;
    if (ev.lane === "done" && record.state === "validated") return this.accept(record);
    if (ev.lane === "cancelled") return this.cancelEngagement(record, "operator");
  }

  private async onGateMoved(ev: Extract<SubstrateEvent, { kind: "lane_moved" }>): Promise<void> {
    if (ev.lane === "ready_to_work") return this.approveStage(ev.at);
    if (ev.lane === "cancelled") return this.rejectStage(ev.at);
  }

  /** idempotent by trail-dedup: reconcile and the live event can both land here */
  private async approveStage(at: string): Promise<void> {
    const decision: GateDecision = {
      kind: "approved",
      stageId: this.plan.stageId,
      planVersion: this.plan.planVersion,
      by: "operator",
      at,
    };
    const outcome = applyGateDecision(this.plan, decision);
    if (outcome.kind !== "authorized") return;
    if (!(await this.gateDecided())) await this.deps.store.appendDecision({ kind: "gate", decision });
    for (const ep of outcome.engagements) await this.dispatch(ep);
    const gate = await this.deps.store.getGateTicket(this.plan.stageId, this.plan.planVersion);
    if (gate) await this.deps.substrate.setLane(gate, "done");
  }

  private async rejectStage(at: string): Promise<void> {
    const decision: GateDecision = {
      kind: "rejected",
      stageId: this.plan.stageId,
      planVersion: this.plan.planVersion,
      note: "operator moved the gate ticket off-board",
      at,
    };
    if (applyGateDecision(this.plan, decision).kind !== "rejected") return;
    if (!(await this.gateDecided())) await this.deps.store.appendDecision({ kind: "gate", decision });
    for (const ep of this.plan.engagements) {
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
  }

  private async gateDecided(): Promise<boolean> {
    const decisions = await this.deps.store.listDecisions();
    return decisions.some(
      (d) =>
        d.kind === "gate" &&
        (d.decision.kind === "approved" || d.decision.kind === "auto_approved" || d.decision.kind === "rejected") &&
        d.decision.stageId === this.plan.stageId &&
        d.decision.planVersion === this.plan.planVersion,
    );
  }

  // ------------------------------------------------------------ dispatch

  /**
   * The dispatch saga (D6 runtime semantics): intent row first, then every
   * effect guarded — mint is idempotent, bind precedes item creation
   * (assignment dispatches immediately, P6 — a late bind leaks spend onto
   * the previous key), findWorkItem before create. A crash resumes; it never
   * re-dispatches blind.
   */
  private async dispatch(ep: EngagementPlan): Promise<void> {
    const rec = await this.deps.store.getEngagement(ep.engagementId);
    if (!rec || rec.state !== "gated") return;

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
    if (resolved || bestBranch !== reported.lastBranch) {
      reported = {
        ...reported,
        ...(bestBranch ? { lastBranch: bestBranch } : {}),
        ...(resolved ? { lastJudgedSha: resolved.sha } : {}),
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
    await this.deps.gateway.revokeKey(next.engagementId);
    await this.setEngagementLane(next);
    await this.deps.substrate.comment(
      next.item!,
      `Escalated: contract failed after ${MAX_BOUNCES} bounces. Operator action required — cancel this ticket or rescope the engagement.`,
    );
    await this.deps.store.appendDecision({
      kind: "termination",
      terminated: { engagementId: next.engagementId, finalState: "escalated", reason: "bounce_limit", at: this.now() },
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
    const contract = this.contractFor(record.engagementId);
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

  private async accept(record: EngagementRecord): Promise<void> {
    if (!record.item || !record.validatedSha) return;
    // merge first: a fast-forward failure leaves the engagement validated and
    // retryable, never half-terminated
    await this.deps.source.fastForward(this.config.repoUrl, this.config.targetBranch, record.validatedSha);
    const accepted = await this.applyTransition(record, { kind: "accepted" }, "operator accepted");
    if (!accepted) return;
    await this.deps.gateway.revokeKey(record.engagementId);
    await this.deps.substrate.close(record.item);
    await this.deps.store.appendDecision({
      kind: "termination",
      terminated: { engagementId: record.engagementId, finalState: "accepted", at: this.now() },
    });
  }

  private async cancelEngagement(record: EngagementRecord, reason: "operator" | "budget_hard_cap"): Promise<void> {
    const cancelled = await this.applyTransition(record, { kind: "cancelled", reason }, `cancelled: ${reason}`);
    if (!cancelled) return;
    if (record.item) await this.deps.substrate.cancel(record.item, reason);
    await this.deps.gateway.revokeKey(record.engagementId);
    if (record.item) await this.deps.substrate.close(record.item);
    await this.deps.store.appendDecision({
      kind: "termination",
      terminated: { engagementId: record.engagementId, finalState: "cancelled", reason, at: this.now() },
    });
  }

  // ------------------------------------------------------------ blockers

  private async onComment(ev: Extract<SubstrateEvent, { kind: "comment" }>): Promise<void> {
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

  // ------------------------------------------------------------- helpers

  private async ensureEngagementsGated(): Promise<void> {
    for (const ep of this.plan.engagements) {
      let rec = await this.deps.store.getEngagement(ep.engagementId);
      if (!rec) {
        rec = {
          engagementId: ep.engagementId,
          stageId: this.plan.stageId,
          planVersion: this.plan.planVersion,
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

  private contractFor(engagementId: string) {
    const ep = this.plan.engagements.find((e) => e.engagementId === engagementId);
    if (!ep) throw new Error(`engagement ${engagementId} is not in stage ${this.plan.stageId} v${this.plan.planVersion}`);
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
   * Apply a domain event; a rejected transition returns null — terminal
   * absorption (the first persisted decision wins) and illegal moves are the
   * caller's signal to ignore, exactly as the termination protocol demands.
   */
  private async applyTransition(
    record: EngagementRecord,
    event: EngagementEvent,
    cause: string,
  ): Promise<EngagementRecord | null> {
    const result = transition(record, event);
    if (!result.ok) return null;
    const updated: EngagementRecord = { ...record, ...result.engagement };
    await this.deps.store.saveEngagement(updated);
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

  private renderPlanBody(): string {
    const lines = [
      `## Stage plan — ${this.plan.kind}`,
      "",
      this.plan.objective,
      "",
      `Plan version: ${this.plan.planVersion} · Stage budget: ${this.plan.budgetCents}¢`,
      "",
      "### Engagements",
      ...this.plan.engagements.map(
        (e) => `- **${e.title}** (${e.role}, ${e.budgetCents}¢) — contract ${e.brief.contract.contractId} v${e.brief.contract.version}`,
      ),
      "",
      "**To approve:** move this ticket to *Ready to work*. **To reject:** move it to *Cancelled*.",
    ];
    return lines.join("\n");
  }
}
