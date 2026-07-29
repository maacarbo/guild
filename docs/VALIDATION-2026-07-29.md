# Guild — Decision Validation Report (2026-07-29)
# Guild Architecture — Final Validation Report

Date: 2026-07-29. Scope: D1–D5 + product core + M5 topology, as written in `/Users/maarten/git/bitstrum/agents/guild/docs/ARCHITECTURE.md`.

## Bottom line

All five areas land on **keep-with-amendments**. No decision needs reversal; none survives unamended either. The adversarial pass attacked every judge verdict and refuted none — an unusually clean evidence base (14 adversarial re-checks, zero fabricated citations) — but it surfaced three characterization defects in the judges' evidence and upgraded several amendments. Critically, for the product core the challenge itself states: **if the amendments are not adopted, the verdict's own evidence argues it flips.** Treat the amendments as blocking, not advisory.

## Where the original decisions were wrong or under-informed

These are the honest failures of the doc as written:

1. **D4 is internally contradictory as specified.** Line 102 declares the JetStream streams "the system of record"; line 118 has agents "claim tasks from its role's queue" on the same TASKS stream. Verified against NATS docs (docs.nats.io/nats-concepts/jetstream/streams): WorkQueuePolicy deletes messages on ack, InterestPolicy deletes after all consumers ack, and limits are enforced regardless of policy. A stream cannot be both a consume-once queue and a permanent record. The doc specifies no retention policy, no idempotency/redelivery semantics, and no event-schema versioning — grep confirms zero occurrences of any of these terms. This is the single most concrete defect found.
2. **D4's alternatives analysis is a strawman.** The only alternative considered (line 104) is Postgres LISTEN/NOTIFY. The real 2026 competitors are durable-execution engines — DBOS (TypeScript-native, Postgres-only, active: dbos.dev/blog/dbos-new-features-march-2026), Temporal, Dapr Workflow. The rejection rationale actually holds (they lack subject addressing, request-reply, pub/sub fan-out; Guild's replay is projection rebuild, not deterministic re-execution) — but it was never made, and no production precedent for bus-as-source-of-truth + external projector was found in 2026 literature.
3. **D2 was decided without knowledge of a directly relevant security incident.** LiteLLM PyPI 1.82.7/1.82.8 were compromised 2026-03-24 (docs.litellm.ai/blog/security-update-march-2026; corroborated by Bitsight, Cycode, Sonatype, OX Security, BerriAI issue #24518). The challenge upgraded the judge's "infostealer" framing: the payload included **Kubernetes lateral movement and a persistent systemd backdoor** (TeamPCP campaign, linked to the 2026-03-19 Trivy compromise). Guild's design makes the LiteLLM pod the sole holder of every provider credential — maximal blast radius, in-cluster. The doc says nothing about supply-chain hygiene.
4. **D2's escape hatch is vaguer than reality permits.** "May talk natively when the client requires it" (line 77) is no longer true for the base case: LiteLLM ships an official Claude Agent SDK tutorial via `ANTHROPIC_BASE_URL` (docs.litellm.ai/docs/tutorials/claude_agent_sdk). Since Claude Code is the *only* runtime in M1–M2, an unqualified native path makes the M6 gateway hard-stop unenforceable for the primary workload.
5. **D3's interface is missing control surfaces both target runtimes expose natively.** No permission/approval path (Claude SDK `canUseTool` / OpenCode `POST /session/:id/permissions/:permissionID`), no interrupt distinct from `retire()`, no serializable/resumable `AgentHandle` — despite the `Waiting(question)` state and M5 Job-per-engagement economics requiring suspend/resume. The Cost & Safety section requires orchestrator-mediated policy checks with no interface path to deliver a permission decision.
6. **The product core, as written, reproduces measured failure preconditions.** MAST (arXiv 2503.13657, NeurIPS 2025, 1,600+ traces): ~41.8% specification issues + ~36.9% inter-agent misalignment. Every verified 2026 success mitigates these through mechanisms Guild lacks: fresh context per unit of work (cognition.com/blog/devin-can-now-manage-devins — explicitly names accumulated-context degradation, which indicts Guild's "persistent" agents claiming successive tasks), pre-implementation machine-checkable contracts (factory.ai/news/missions-architecture — validation-contract.md written before code, serial workers per milestone), full-trace visibility (cognition.com/blog/dont-build-multi-agents, Principle 1), and pre-execution plan gates (Jules, Kiro, Spec-Kit, Copilot Plan Mode). Guild's Review column is post-hoc only. Add ~15x token cost (Anthropic multi-agent research post) with budget enforcement deferred to M6 while fan-out starts at M1 — an unpriced exposure window.
7. **M5 pod spec has no isolation runtime.** Agent Jobs would run on default shared-kernel runc while executing LLM-generated builds with network access to the credential-bearing gateway. Upstream Kubernetes itself (kubernetes-sigs/agent-sandbox, agent-sandbox.sigs.k8s.io) names gVisor/Kata RuntimeClasses as the baseline for this workload class; hyperscalers converge on the same (AWS Firecracker per session, Azure per-session sandboxes, GKE gVisor). Also: DNS is unscoped in the NetworkPolicy — the textbook L3/L4 egress bypass.

## Where the decisions were right

- **D1 layering**: no LF-governed standard targets an internal single-tenant coordination bus. A2A scopes itself to cross-org/untrusted boundaries; AG-UI is backend-to-frontend; CNCF (cncf.io/blog/2026/03/23) treats interop protocols and event infrastructure as complementary layers. NATS governance risk is resolved (trademark to Linux Foundation 2025-05, Apache-2.0, active nats.js v3). Synadia's NATS Agent Protocol (nats.io/blog/nats-native-protocol-for-ai-agents) independently validates NATS-native agent addressing + request-reply — with the challenge's caveat that its subjects are verb-first, so "same pattern as D1" is a mild overreading.
- **D2 core choice**: no credible challenger for the exact niche. Helicone in maintenance mode post-Mintlify acquisition; Kong gates token-aware limiting behind enterprise SaaS; Bifrost's case rests on its own vendor's mock-upstream benchmarks (getmaxim.ai); gateway overhead is noise against inference latency (deepinspect.ai). OpenHands made the identical choice. The migrate-off-after-the-compromise argument was explicitly tested and fails: publisher-credential hijack, ~40-minute exposure, every alternative weaker.
- **D3 core bet**: wrapping full agentic clients matches industry convergence (GitHub Agent HQ, Factory, Synadia treating Codex/OpenCode/Claude Code as peers); AutoGen/Semantic Kernel maintenance mode demonstrates framework-lock-in risk. OpenCode's headless server (sessions, prompt_async, SSE events, permissions endpoint, AGENTS.md init, OpenAPI-generated TS SDK) makes the second adapter demonstrably mappable today. AGENTS.md is a cross-vendor LF convention — AgentSpec composition is runtime-neutral.
- **Product shape**: kanban-as-fleet-UI independently reinvented four times (GitHub Mission Control, Vibe Kanban, agent-kanban, ai-agent-board); correlation-id Q&A matches the LangGraph interrupt/Agent Inbox standard; the Cognition absolutist critique is obsolete — its author shipped a coordinator-of-Devins in March 2026.
- **D5/M5**: SSE-first is 2026 consensus; Job-per-engagement fits run-to-completion; secrets-only-in-gateway matches the Vault/ESO pattern.

## Corrections to judge evidence (from the adversarial pass — apply before citing)

1. **D1's MCP-roadmap evidence entry asserts the opposite of the source.** MCP's 2026 roadmap (blog.modelcontextprotocol.io) names agent communication as a priority area ("fractal" agentic systems); A2A v1.0 went stable March 2026 with LF-claimed production deployments. "No standard targets this space" is eroding at the coordination layer. Verdict unchanged (neither provides durable queues, fan-out to Jobs, or an event-sourced record), but the revisit trigger must become a periodic re-check, not "before M4+ external hiring."
2. **D3's `open-code.ai` citations are an unofficial third-party mirror.** Content cross-checks against official opencode.ai docs, but re-confirm the permissions-endpoint path against the official OpenAPI spec before it enters D3's text. Also, claude-agent-sdk-typescript issue #366 (unclean interrupt) appears fixed in later releases — verify against the current SDK before writing an adapter-workaround note.
3. **D2's Redis point is stronger than the judge stated**: beyond the missing Redis dependency, open accuracy bugs (BerriAI #20886 stale reads allowing overruns, #26672 enforcement bypass) mean hard ceilings additionally need the fail-closed enforcement setting.

## Consolidated amendments (blocking)

Per-area amendments are in the table. Cross-cutting priorities:

- **Now (doc edits before M1 code)**: D4 stream retention + idempotency + envelope versioning; D2 default inversion with M1 feature-parity acceptance test (prompt caching, extended thinking through the proxy); D2 supply-chain hardening incl. K8s blast-radius controls; D3 interface extensions; product-core amendments (context-fresh persistence, plan-approval gate, handoff contracts, single-writer, M1 soft budget guard + gateway spend logging).
- **M5 gates**: runtimeClassName (gVisor/Kata, benchmark first), DNS-scoped NetworkPolicy, and — upgraded per the challenge — an explicit **evaluation gate**: assess K8s Agent Sandbox (SandboxTemplate/Claim, pause/resume, persistent storage) against Job-per-engagement before building the M5 substrate, since it natively provides what three separate amendments hand-roll onto Jobs.

## Claims that remain unverified

Quarantined honestly — do not cite as fact:

- Comparative broker/gateway benchmarks (NATS ~820K msg/s; Bifrost 54x; Kong 228–859%; LiteLLM Rust 7.5ms→0.05ms) — all vendor-sourced, mock upstreams.
- Whether decentralized pull-queue task claiming avoids MAST-class coordination failures — no comparable production system found; also, "no production system uses it" is absence-of-evidence, not a verified fact.
- Synadia NATS Agent Protocol adoption depth (fresh spec, zero cited deployments); A2A production adoption beyond LF press claims.
- LiteLLM Anthropic-endpoint full feature parity for Claude Code (streaming/tool-use demonstrated; caching/extended-thinking/computer-use not enumerated) — this is why the native escape hatch survives as a fallback.
- Whether LiteLLM container images (vs PyPI) were affected by the March 2026 compromise.
- OpenCode production stability at Guild's scale; plugin-vs-hooks parity; the PyPI opencode-agent-sdk's drop-in fidelity.
- Jules Planning Critic "9.5%" figure; Devin 16%→80% self-merge rate; Spec-Kit "60–80% fewer rework cycles"; "Recognize Your Orchestrator" preprint stats — single-source or vendor self-reported.
- Per-mode MAST breakdown beyond category level; the "most production systems use durable execution or plain DB state" trend claim (synthesis, not survey).
- OTel GenAI semconv status rests substantially on one blog (john-hodge.com), though independently corroborated as still-experimental by greptime.com and opentelemetry.io; gVisor I/O overhead on Guild's build workloads unbenchmarked; GKE Agent Sandbox growth figures are Google's own.
- Firecracker CVE-2026-5747 / CVE-2026-1386 details not cross-checked against NVD.
- Whether AG-UI's vocabulary covers `task.moved` / `agent.hired` without custom extensions — the mapping exercise has not been performed by anyone.


# Verdict Table with Doc Amendments

## D1+D4 — NATS JetStream event contracts; streams as system of record, Postgres projection

**Final verdict:** keep-with-amendments

**Key evidence:** WorkQueue/Interest retention deletes acked messages (docs.nats.io/nats-concepts/jetstream/streams) while ARCHITECTURE.md lines 102/118 ask TASKS to be both queue and permanent record with zero retention/idempotency/versioning language; no standard covers the niche (A2A cross-org scoped, CNCF 2026-03-23 layering) but MCP's 2026 roadmap is moving INTO agent coordination (judge's evidence entry corrected); NATS governance resolved (LF trademark 2025-05, Apache-2.0); DBOS/Temporal/Dapr absent from the alternatives table (line 104); no production precedent found for bus-as-truth + external projector.

**Amendments:**
- Mandate LimitsPolicy retention (unlimited/project-lifetime) for TASKS/QA/AGENTS; forbid WorkQueue/Interest for system-of-record streams; task claiming via durable pull consumers over the limits-retained stream.
- Document delivery semantics: at-least-once + explicit ack, envelope `id` as dedup key for all consumers incl. board projector, AckWait/MaxDeliver, poison-message handling; add `version` field to the envelope with an upcasting policy.
- Expand D4 alternatives table with DBOS (TS-native, Postgres-only) and Temporal/Dapr Workflow rows, recording the rejection rationale; revisit trigger: evaluate DBOS if orchestrator logic accretes retry/timer/compensation semantics.
- Add honest precedent note: no production reference for JetStream-as-source-of-truth + external projector found (2026); revisit on projection-rebuild or schema-evolution pain at M6 scale.
- Correct the interop framing: MCP roadmap and A2A v1.0 are advancing toward coordination territory — replace the milestone-bound revisit with a periodic standards re-check; scope an A2A adapter before any external-agent hiring; evaluate AG-UI event mapping before M2 UI hardening; watch (do not adopt) Synadia's protocol, noting its subjects are verb-first, not strictly subject-per-agent.
- Record an explicit decision on handoff context visibility (upstream trace vs externalized artifact reference) — ties into Open Question 1 and the dominant MAST failure category.

## D2 — LiteLLM gateway, per-role model policy, native-SDK escape hatch

**Final verdict:** keep-with-amendments

**Key evidence:** Official LiteLLM tutorial routes the Claude Agent SDK through the proxy via ANTHROPIC_BASE_URL (docs.litellm.ai/docs/tutorials/claude_agent_sdk), so line 77's 'when the client requires it' no longer holds for the base case; March 2026 PyPI compromise of 1.82.7/1.82.8 verified across six sources — with K8s lateral movement and systemd backdoor stages the judge understated; Python→Rust migration GA ~Dec 2026 overlaps M1–M2; budget hard-stops need Redis plus fail-closed enforcement (BerriAI #20886/#26672); all alternatives verified weaker (Helicone maintenance mode, Kong enterprise-gated, Bifrost vendor-benchmarked, Portkey hosted-first).

**Amendments:**
- Invert the escape hatch: Claude Code adapter routes through LiteLLM via ANTHROPIC_BASE_URL by default; native-direct requires a documented capability blocker plus spend reconciliation; make Claude feature parity through the proxy (prompt caching, extended thinking) an explicit M1 acceptance test.
- Supply-chain hardening: pin exact version AND container-image digest, delayed+scanned upgrade window, referencing the March 2026 compromise; add K8s blast-radius controls for the gateway pod (dedicated namespace, egress NetworkPolicy, no privileged service account) given the payload's lateral-movement stage.
- Currency note: Rust hot-path migration in flight (/messages Sept, full server Dec 2026); pin and gate upgrades through it; extend 'Revisit if' with Anthropic-endpoint/routing/budget regressions.
- Surface the Redis dependency: either document single-replica LiteLLM (accepted SPOF) or add Redis/Valkey to the M5 stack; note the fail-closed budget-enforcement setting is required for genuine hard stops.
- Optional: note litellm-operator (CRDs) for M5 declarative config; footnote that competitor benchmarks are vendor-sourced and gateway overhead is immaterial at Guild scale.

## D3 — AgentRuntimeAdapter interface, Claude Code first, OpenCode M3

**Final verdict:** keep-with-amendments

**Key evidence:** Claude Agent SDK streaming mode (persistent session, mid-session injection, interrupts, permission requests, resume — code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) and OpenCode's headless server (sessions, prompt_async, SSE, permissions endpoint, AGENTS.md init — verified against official opencode.ai docs after the judge cited an unofficial mirror) both expose control surfaces the D3 interface lacks: permissions, interrupt, serializable handle; AGENTS.md is a cross-vendor LF convention (60k+ repos); industry converged on wrapping heterogeneous runtimes (GitHub Agent HQ, Factory, Synadia); issue #366 appears already fixed upstream.

**Amendments:**
- Add a permission-decision surface: respondToPermission(handle, requestId, decision) or a first-class AgentEvent variant with required reply path — the Cost & Safety section's policy checks currently have no interface path.
- Add interrupt(handle)/cancel(handle, taskId) distinct from retire(); verify the interrupt behavior against the CURRENT Claude SDK release before documenting a workaround (issue #366 likely fixed).
- Specify AgentHandle as serializable, carrying the runtime's native session id, enabling suspend/resume of Waiting agents (Claude SDK resume / OpenCode server sessions) — required for M5 Job economics and crash recovery.
- Replace 'Later: OpenCode, others' (line 50) with a verified endpoint mapping paragraph; re-confirm the permissions endpoint path against the official OpenAPI spec first.
- Pin Claude Agent SDK versions (V2 session API in preview); isolate SDK churn behind the adapter.
- Replace the Claude-idiom 'hooks' in AgentSpec (line 94) with a per-adapter capability mapping table, delivered as an M3 acceptance test.

## Product core — hired persistent specialist roles, event coordination, kanban + question-feed HITL

**Final verdict:** keep-with-amendments

**Key evidence:** All load-bearing sources verified primary and quoted accurately: MAST 41.8%/36.9%/21.3% (arXiv 2503.13657); Managed Devins clean-slate-per-child with accumulated-context degradation explicitly named (cognition.com/blog/devin-can-now-manage-devins, 2026-03-19); Factory's pre-code validation-contract.md, fresh context per feature, serial workers (factory.ai/news/missions-architecture); ~15x token multiplier (Anthropic); kanban-fleet-UI independently converged four times; plan gates first-class in Jules/Kiro/Spec-Kit/Copilot. Challenge conclusion: amendments are blocking — as written the docs reproduce measured failure preconditions, and no production precedent exists for decentralized pull-queue claiming.

**Amendments:**
- Redefine 'persistent' as role-persistent, context-fresh: identity/workspace/artifacts persist, LLM context resets (or compacts against a role-memory artifact) per engagement.
- Add a stage-plan approval gate as first-class UX before execution spend, with a bounded auto-approve timer (Jules pattern); optional critic-agent review at M2+.
- New decision record: per-stage machine-checkable handoff contracts (Factory validation-contract.md pattern) — acceptance criteria authored upstream before implementation; tester validates against the contract, never the implementer's self-report.
- Add a trace-visibility rule: reviewers/tester/orchestrator can read upstream full traces or structured decision logs as workspace artifacts — or explicitly record the Factory-style externalized-artifact alternative as the chosen design.
- Resolve Open Question 1 as single-writer discipline: one writing agent per branch/workspace, parallelism only on non-overlapping branches, orchestrator-mediated merges.
- Pull a soft per-engagement budget cap with kill-switch forward to M1–M2 (full hierarchical enforcement stays M6) — 15x token multiplier meets M1 fan-out otherwise.
- Add a revisit trigger on pull-queue claiming: if M1 retros show handoff misalignment or duplicated work, fall back to orchestrator-dispatched assignment over the existing inbox subjects (routing change, not rework).

## D5 + M5 — Next.js/SSE UI; K8s Jobs + PVC workspaces, egress allowlist, gateway-only secrets; OTel at M5

**Final verdict:** keep-with-amendments

**Key evidence:** SSE-first is 2026 consensus and Q&A correctly rides NATS request-reply; AG-UI verified transport-agnostic with first-party AWS AgentCore + Microsoft Agent Framework support (github.com/ag-ui-protocol/ag-ui) — unevaluated in D5; K8s SIG agent-sandbox names gVisor/Kata as baseline for agent-generated code while M5 specifies no RuntimeClass; DNS unscoped in NetworkPolicy; OTel GenAI semconv still experimental (independently corroborated), but LiteLLM spend/OTel export is available at M1 — the missing mechanism behind line 163's 'tracked from M1'; challenge landed one hit: Agent Sandbox maturity (stable APIs, pause/resume, 16x growth) warrants an M5 evaluation gate, not a footnote.

**Amendments:**
- D5: add AG-UI to the alternatives table; record 'bespoke SSE transport, AG-UI-aligned event payloads' or explicitly reject with rationale.
- D5: revisit trigger — any mid-stream client-to-server need introduces a transport abstraction in the UI client; SSE specifics must not leak into the orchestrator API contract.
- M5: specify runtimeClassName (gvisor or kata) on agent Job pod templates; default runc is below the 2026 baseline for executing agent-generated builds; benchmark gVisor I/O overhead on representative builds before choosing.
- M5: scope DNS in the NetworkPolicy to the cluster resolver, cluster-internal only; note prompt-path exfiltration via LiteLLM is a governance item, not a NetworkPolicy item.
- M5 (upgraded per challenge): add an explicit evaluation gate — assess K8s Agent Sandbox (SandboxTemplate/WarmPool/Claim: pause/resume, persistent storage, hardened runtimes) against Job-per-engagement BEFORE building the M5 substrate, since it natively covers what the D3 handle, D5 runtime, and PVC amendments each hand-roll.
- Split observability: M1 — enable LiteLLM spend logging + OTel/Langfuse export at the gateway (concrete mechanism for 'tracked from M1'); M5 — full GenAI-semconv tracing with version-pinned instrumentation and budget for at least one attribute-rename migration.
