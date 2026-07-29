# Guild vs. Multica — Premise Check

**Verdict up front:** Guild's premise as a whole product does not survive contact with multica. Guild is 5 commits (150 lines of TS scaffold, no working code) proposing to rebuild, on a 6-milestone roadmap, roughly 60% of a system that already ships at 42,506 stars / 5,379 forks (re-verified live via `api.github.com/repos/multica-ai/multica`, 2026-07-29), with near-daily releases and real production usage. The part of Guild that is genuinely novel — enforced staged SDLC with approval gates and machine-checkable handoffs — is real and multica verifiably lacks it. But that's a thin governance slice riding on infrastructure (bus, board, runtime adapters, kanban, Q&A, skills catalog, cost tracking, K8s deploy) multica has already built and hardened through 1,230 open issues of real-world friction.

All GitHub stats, the LICENSE text, the Helm template list, and the "flat issues, no epics" claim were independently re-fetched by me today, not taken on the pooled researchers' word alone.

---

## 1. Overlap matrix

| Guild capability | Multica status | Evidence |
|---|---|---|
| **Idea → staged SDLC pipeline** (BA→architect→implementer→tester as enforced stages) | **VERIFIED-ABSENT** | Re-confirmed live via WebFetch of `multica.ai/docs/issues` today: no epics, no sub-issues, no dependency relationships — "flat issue tracking." 7 unordered statuses, "any status can move directly to any other." Multica's own README: work model is flat task assignment ("assign to an agent like a colleague"), no mention of staged analysis→architecture→implementation→test→deploy. GitHub issue #815 (15 reactions) argues this gap from inside the community: "human-led not AI-led," no workflow/state-machine engine. |
| **Plan approval gates** | **VERIFIED-ABSENT** | `/docs/how-multica-works` and `/docs/tasks` (checked): no pre-execution approval/checkpoint; task moves `dispatched`→`running` on the daemon's ~3s poll, no gate. Top-voted *open* feature request (#1943 "Workflow Orchestration," 17 reactions) asks for exactly this. |
| **Handoff contracts** (upstream-authored acceptance criteria, downstream-validated) | **VERIFIED-ABSENT** | No contract artifact documented in `/docs/tasks`, `/docs/squads`, `/docs/agents`. Only cross-agent handoff is an `@mention` comment. Matches issue #1579's documented failure: agent self-reported "done" on incomplete work, nothing validated it downstream, user lost trust after two weeks. |
| **Dynamic team hiring** | **VERIFIED-ABSENT** | Squads are static, human-configured via CLI, admin/owner privileged. Open feature request #2707 (squad *portability*) confirms even export isn't shipped, let alone demand-driven auto-composition. Note: Guild also defers this to M4 — parity of non-delivery today, not a Guild lead. |
| **Context-fresh engagements** | **UNKNOWN** | No source in either research pass, nor my own checks, describes per-task context handling. Genuinely unknown, not inferred. |
| **Per-role model policy + budget kill-switch** | **PARTIAL** (model policy: HAS; kill-switch: absent) | Model selection: HAS (`/docs/agents-create`, 17-CLI matrix). Cost tracking: HAS at reporting level (raw migration `213_task_usage_authoritative_cost.up.sql`, dedicated cost/token charts). **Budget caps / kill-switch: absent** — `/docs/environment-variables` documents no cost-limiting vars; researcher's repo-wide filename search found zero backend hits. I could not independently re-run that exact code search (GitHub code search needs auth I lack this session), so this sub-claim is corroborated-by-convergence, not independently re-verified by me. Duplicate open issues #4349/#4358 ("high token consumption") are a live symptom. |
| **Event-sourced coordination** | **PARTIAL** | A `timeline` audit table exists (append-only, `source`-tagged, e.g. `github_pr_merged`) — real. But issue `status` is a mutable column updated *alongside* the timeline write, not derived by replay — audit-logging, not event-sourced state. Guild's design differs architecturally and more purely, but Guild's own ARCHITECTURE.md admits "no production precedent found for this exact shape" — differentiated but unproven. |
| **Runtime adapters** | **HAS**, broader than Guild's entire roadmap | Multica auto-detects/drives 14+ CLIs today. Guild ships 1 adapter at M1, a 2nd at M3 — multica's current adapter breadth already exceeds Guild's full 6-milestone runtime plan. |
| **Sandboxed K8s agent execution** | **VERIFIED-ABSENT** | Helm templates re-fetched today: `_helpers.tpl, backend.yaml, configmap.yaml, frontend.yaml, ingress.yaml, postgres.yaml, prometheusrule.yaml` — no daemon/agent template. Chart is control-plane only; agent execution is a local daemon with the user's own OS permissions, no isolation documented. **This is the cleanest genuine gap in the matrix** — but it's Guild's M5, five milestones past an unshipped M1. |
| **Kanban + question routing** | **HAS** (board) / **PARTIAL** (correlation) | Board with assignee/status/comments/timeline: confirmed. Structured correlation-id routing to the specific asking agent instance (vs. implicit comment-thread context): not documented anywhere I or the researchers found, including direct fetches of `/docs/mentioning-agents` and `/docs/inbox`. |
| **Skills / capability catalog** | **HAS**, more mature than Guild's M4 plan | Anthropic Agent Skills standard, 3 creation paths including a public marketplace (ClawHub), workspace-level sync. Guild's catalog is M4, zero lines implemented. |

---

## 2. Honest verdict

**Guild would be rebuilding:** runtime adapters, kanban board, Q&A substrate, skills catalog, cost/token dashboards, GitHub/Slack integration, activity logging, multi-CLI provisioning — the majority of Guild's M1–M4 scope by volume. None of it is exotic; it's exactly the infrastructure that took a fast-moving team six months to harden against 1,230 open issues' worth of real-world edge cases a from-scratch scaffold hasn't hit yet.

**Guild is genuinely differentiated, and verified so, on:**
- Enforced staged pipeline with approval gates — multica is confirmed flat and gate-free.
- Machine-checkable handoff contracts validated downstream, not self-reported — directly answers a documented multica production failure (#1579), not a hypothetical.
- Sandboxed K8s execution as a design target — multica's daemon runs unsandboxed with full local permissions; but this is Guild's last milestone, not close to demoable.
- Event-sourced-as-source-of-truth vs. multica's mutable-state-plus-audit-log — cleaner, but self-admittedly unproven at production scale.

Net: Guild's differentiated layer is a governance/policy layer, not a platform. Every piece of plumbing it needs already exists in multica, unencumbered for internal/API use. Building that plumbing from scratch before the differentiators even become testable is a multi-month tax with zero differentiation payoff along the way.

---

## 3. Strategic options — recommendation: **(b)**

- **(a) Proceed as designed — reject.** Duplicates ~60% of shipped multica surface before Guild's own gates/contracts differentiators are even testable. Not a fair infrastructure fight; only a fair governance-layer fight, and (a) doesn't isolate that fight.

- **(b) Reposition Guild as the autonomous-SDLC governance layer, integrate with/on multica — RECOMMENDED.**
  License (re-read from raw LICENSE today): modified Apache 2.0, `NOASSERTION` per GitHub — **permits** using multica "as a backend service for other applications" and internal multi-workspace use without a commercial license; **prohibits without a paid commercial license**: offering multica as a hosted service to third parties, embedding it in a commercially-sold product, or altering frontend branding. For Guild-as-internal-tool or Guild-as-open-source-project-driving-multica's-API (REST+WS, PAT auth — multica-ai even ships a companion `multica-cli` for agent-driven use), this is plausibly clear. **The moment Guild is sold or SaaS-hosted while embedding multica, this needs actual legal review — flag explicitly, don't assume it away.**
  Concretely: Guild decomposes ideas into staged plans with approval gates, drives multica's task API to dispatch scoped work per stage, validates output against machine-checkable contracts before advancing stages. This reuses multica's board/adapters/skills/cost-tracking wholesale and spends 100% of Guild's limited runway on the ~20% that's novel and evidenced as valuable.

- **(c) Narrow Guild to only the differentiated layer, backend-agnostic** — fallback if (b)'s license/API review fails. Ship the staged-planning + gate + contract engine as a thin layer over *any* task-API backend (multica, raw Claude Code, GitHub Agent HQ), not owned kanban/adapter/skills infrastructure. Hedges license risk, less leverage than (b).

- **(d) Abandon — not warranted.** The evidenced gap (#815, #1579, #1943) is real; Guild's answer is coherent. The problem is scope, not premise.

**Recommendation: (b), with a dated legal/license checkpoint before any commercial packaging, falling back to (c) if that checkpoint fails or multica's API proves too thin for contract-validation hooks (unverified — untested by anyone in this review).**

---

## 4. What Guild should steal from multica regardless

1. Multi-CLI adapter breadth as table stakes (14+ shipped vs. Guild's 1-then-2 plan).
2. Skills via the open Agent Skills standard + a marketplace model, rather than inventing Guild's own M4 catalog format from scratch.
3. Cost/token dashboards shipped early, not deferred to M5 — Guild's own docs cite ~15x multi-agent token cost as a risk.
4. Treat self-reported "done" as hostile input, always — issue #1579 is the single strongest piece of evidence in this whole review and should be cited in ARCHITECTURE.md as concrete justification for D6, not just the abstract MAST-taxonomy percentage already there.
5. A companion CLI/skill so agents (not just humans) can drive the platform via one documented API — mirror `multica-cli`.
6. Explicitly do **not** copy: the gate-free flat model, unsandboxed local-daemon-only execution, and mutable-state-plus-audit-log persistence — issue #815 and Guild's own architecture already correctly flag these as weaknesses.

---

## Confidence notes — what's still genuinely unverified

- Budget/kill-switch absence: corroborated by two independent research passes plus a docs gap I fetched directly, but I could not re-run the GitHub code search myself (auth-gated) — high-confidence, not independently re-verified by me.
- Context-fresh engagement behavior: genuinely UNKNOWN, not inferred from absence of documentation.
- Correlation-id question routing: PARTIAL/UNKNOWN as a specific mechanism — practical outcome plausible via comment threads, structured mechanism unconfirmed either way.
- License applicability to Guild's specific eventual distribution model: flagged, not resolved — needs review by someone with authority to bind the project, not just this review's plain-English gloss.

**Files referenced:** `/Users/maarten/git/bitstrum/agents/guild/docs/PRODUCT.md`, `/Users/maarten/git/bitstrum/agents/guild/docs/ARCHITECTURE.md`, `/Users/maarten/git/bitstrum/agents/guild/docs/ROADMAP.md`, `/Users/maarten/git/bitstrum/agents/guild/docs/VALIDATION-2026-07-29.md` (checked, no multica mentions), repo git log (confirmed 5 commits), `packages/**/*.ts` (confirmed 150 LOC scaffold, no UI code).