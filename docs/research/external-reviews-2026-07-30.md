# External Design Reviews — 2026-07-30

Four independent non-Anthropic models reviewed the full Guild design via OpenRouter, each with a
dimension-specific context envelope (mandate -> verified upstream facts & constraints -> project
conventions -> deliverable -> context). All four returned REJECT. Raw outputs below, unedited.
Consolidated assessment and the resulting design revisions are tracked in the repo issues.

| Dimension | Model | Decision |
|---|---|---|
| Requirements | google/gemini-3.1-pro-preview | REJECT |
| Architecture | qwen/qwen3-max-thinking | REJECT |
| Functional analysis | openai/gpt-5.4 | REJECT |
| Security (design-level) | kwaipilot/kat-coder-pro-v2 | REJECT |


---

## Requirements review — `google/gemini-3.1-pro-preview`

DECISION: REJECT
The requirements contain critical gaps regarding workspace technical execution (how Guild reaches the agent's code to test it) and introduce dangerous auto-approve defaults for a solo operator. 

ISSUES:

- BLOCKER: **Auto-approve timer bypasses financial safety (Section: `PRODUCT.md` - Core Flows #2)**
  *The problem:* The deliverable states "bounded auto-approve timer — silence is consent after the window." For a solo operator, this means if an agent submits a flawed, expensive plan while you are asleep or at your day job, the system will auto-approve it and begin burning tokens. This directly undermines the foundational problem statement ("No budget enforcement").
  *Fix:* Require explicit human approval for all plan and budget gates. Remove the auto-approve timer. 

- BLOCKER: **Contract Validation execution context is a black hole (Section: `PRODUCT.md` - Core Flows #4)**
  *The problem:* The spec says "Guild validates the contract itself — it never trusts the agent's self-report." However, the agent's workspace exists inside a remote Multica daemon container running in a K8s pod. How does Guild (the control plane) physically execute the Gherkin specs against the agent's code without trusting the agent to run the tests itself? If this isn't solved in M1/M2, the primary value proposition (machine-checkable handoffs preventing spurious completion) is impossible to implement.
  *Fix:* Specify exactly where and how validation runs. (e.g., "Agents must push to a Git branch; Guild triggers and reads the verdict from an isolated GitHub Actions/Tekton CI pipeline," OR "Guild executes tests directly via K8s exec into the daemon pod").

- BLOCKER: **Generated code lifecycle and retrieval is undefined (Section: `PRODUCT.md` - MVP Cut & `ROADMAP.md` Open Questions)**
  *The problem:* The success criteria require "submission to a repo with passing tests." But Multica daemons execute locally inside ephemeral K8s pods. If an agent completes a task and the pod cycles, the solo operator has no way to retrieve the created UI/code. You cannot wait until M2 to decide "where generated products live" if you are writing isolated K8s pods in M1.
  *Fix:* Explicitly define the code handoff. The daemon container footprint in M1 must guarantee a Git push/PR capability or map a persistent volume to the workspace that the user can securely access. 

- CONCERN: **API Cancellation vs. Token Burn cascade untested (Section: `ROADMAP.md` - M1 & M3)**
  *The problem:* M3's budget kill-switch assumes cancelling the issue via the Multica REST API will stop the spend. However, Multica forks subprocesses (Claude Code, etc.). If the Multica daemon only marks the issue cancelled but does not send a SIGTERM to its running child CLI wrapper, the agent will gracefully finish its loop and keep spending money despite the Multica issue being closed.
  *Fix:* In M1 under "Probe the API surface", explicitly add a test to verify that cancelling an issue via the API *hard-kills* the forked CLI process and instantly ceases LiteLLM traffic.

- CONCERN: **Over-engineered M1 datastore requirements (Section: `ROADMAP.md` - M1 datastores)**
  *The problem:* The M1 spec requires building and documenting *both* in-cluster K8s PV datastores and external datastore configurations from day one, delaying core platform execution to accommodate future "other users". The context mandates "solo operator, personal use" as the primary constraint. 
  *Fix:* Pick exactly one datastore mode for M1 based on what is fastest for standardizing the local dev K8s environment (likely in-cluster PVs). Defer external datastore documentation/testing entirely to a post-M4 open-source polishing phase.

- MINOR: **Testing API prompt caching through a black-box daemon (Section: `ROADMAP.md` - M1 Dev gateway)**
  *The problem:* M1 tasks the operator to verify prompt caching from *inside* the daemon container via acceptance test. Guild does not control the actual Multica binaries or Claude CLIs. If the upstream CLI tool does not natively emit caching headers or expose caching UI, your automated test will fail indefinitely.
  *Fix:* Restrict the prompt caching acceptance test to verify that the *LiteLLM gateway* correctly forwards caching headers, rather than trying to assert caching through the black-box daemon's output.


---

## Architecture review — `qwen/qwen3-max-thinking`

REJECT

VERDICT RATIONALE:  
The design contains a critical flaw in the daemon provisioning model that violates the project’s own hard constraints and creates an irrecoverable operational risk. The assumption that the Multica daemon can be packaged as a single container with all agent CLIs baked in contradicts Multica’s verified architecture and introduces untestable, unscalable, and insecure runtime coupling.

CRITICAL ISSUES:
1. **Daemon image assumes monolithic CLI bundling, violating Multica’s agent independence and creating a brittle, unversioned runtime environment** — Multica agents are defined by per-agent runtime CLI + model, and the daemon forks the CLI *at task time*. Bundling all CLIs into one image (as proposed in `docker/daemon/`) conflates runtime lifecycles, prevents independent updates, and makes the image explode in size and attack surface. This directly contradicts the verified fact that “agents are registry entries with per-agent runtime CLI” — the system supports 14+ CLIs, many of which are large, licensed, or platform-specific (e.g., proprietary Codex tooling). There is no evidence this image can be built reproducibly, let alone run all CLIs correctly (e.g., GPU drivers, auth flows, sandboxing requirements). The M1 task “build and prove the daemon container” will fail at scale.
2. **Budget enforcement depends on LiteLLM spend tagged by engagement, but the tagging mechanism is missing** — the architecture assumes the watchdog can read “spend per Guild-scoped key/tag” (F7), yet no mechanism exists to inject engagement-level tags into agent CLI → LiteLLM calls. Agent CLIs use base URL env vars (`ANTHROPIC_BASE_URL=...`), which do not carry contextual metadata. Without a proxy or header injection layer (which doesn’t exist), LiteLLM sees only model calls, not which engagement they belong to. Thus, the watchdog cannot enforce budgets per engagement — a core product promise (PROBLEM section, Flow 6).
3. **Multica daemon runs untrusted LLM-generated code but lacks runtime isolation per task** — while gVisor is planned for M3, the current design has one daemon container running *all* agent CLIs as subprocesses sharing the same filesystem, network, and environment. An agent writing to `/tmp` or spawning a child process can interfere with or exfiltrate data from concurrent engagements. The claim of “per-engagement session state (fresh per issue)” is false at the OS level — sessions are logically fresh but physically co-located. This violates the trust boundary ("least-trusted workload") and enables cross-engagement contamination.

SCALABILITY ASSESSMENT:  
The design fails at 2x scale, not 10x. Adding a new agent runtime (e.g., Ollama) requires rebuilding and redeploying the *entire* daemon image — a full cluster rollout for a single tool addition. This is untenable even for a solo operator managing a few projects. The LiteLLM spend tagging gap also means budget enforcement collapses as soon as more than one engagement runs concurrently, since spend is unattributed.

COUPLING ASSESSMENT:  
Excessive hidden coupling exists between the daemon image and every supported agent runtime. The `substrate-multica` adapter correctly abstracts Multica’s API, but the execution substrate’s *runtime provisioning* is not abstracted — it’s hardwired into a monolithic container. This couples Guild’s release cycle to every agent CLI’s compatibility matrix (Node, Python, auth, deps). Furthermore, the conductor assumes all agent capabilities are present in the daemon, but Multica’s agent registry may reference a CLI not in the image — leading to silent task failures.

TRADE-OFF ASSESSMENT:  
The trade-off analysis in D8 is honest about license and control, but it ignores a critical third option: **run agent CLIs externally via a sidecar or ephemeral job per task**, rather than baking them into a monolithic daemon. The “build own platform” option was rejected for good reason, but the chosen path overcorrects into an over-constrained, brittle execution model. The team assumed that because Multica’s daemon forks CLIs, it must run them all in one process tree — but in a containerized world, a “daemon” can delegate to short-lived, purpose-built containers per task (e.g., via K8s Job or pod-per-task). This was not considered.

SECURITY ARCHITECTURE:  
Trust boundaries are well-defined in theory but violated in practice. The daemon is correctly labeled “least-trusted,” but its implementation provides no per-task sandboxing until M3 (gVisor). Even with gVisor, co-locating all CLIs in one sandbox is unsafe. More critically, the missing engagement tagging in model calls means budget enforcement cannot work — and if budgets can’t be enforced, the kill-switch is a placebo. Additionally, git credentials are stored in the daemon Secret, but multiple agents with different repo access needs must share them — violating principle of least privilege.

TESTABILITY:  
The daemon container is explicitly “untested end-to-end,” and the monolithic CLI bundling makes it nearly impossible to test. How does one verify that the Codex CLI works without violating license terms in CI? How does one test Windows-only CLIs on an amd64 Linux cluster? The port contract tests for `ExecutionSubstrate` are sound, but they cannot cover runtime correctness — only API shape. The budget enforcement logic in the watchdog cannot be unit-tested because the spend attribution mechanism doesn’t exist.

TOP 3 RISKS:
1. Daemon image fails to support required agent CLIs due to size, licensing, or runtime conflicts — High likelihood, High impact (blocks M1).
2. Budget enforcement is non-functional due to missing spend attribution — High likelihood, High impact (core product promise broken).
3. Cross-engagement contamination or credential leakage from shared daemon process space — Medium likelihood, High impact (security breach in personal cluster).

RECOMMENDATIONS:
1. **Replace monolithic daemon image with per-task ephemeral execution**: Use K8s Jobs or a pod-per-task model where each engagement launches a purpose-built container with only the required agent CLI, git creds scoped to the product repo, and LiteLLM env with engagement tags injected via headers or a sidecar proxy. This aligns with Multica’s task-per-process model while enabling isolation and testability.
2. **Implement engagement tagging via LiteLLM virtual keys or headers**: Assign each engagement a unique LiteLLM virtual key (or use headers like `X-Guild-Engagement-ID`) so spend is attributable. Update agent CLIs or inject a minimal proxy to carry this context — this is non-negotiable for budget enforcement.
3. **Defer CLI bundling decisions**: Do not bake all CLIs into one image. Instead, let the staffing layer (M4) specify image per role, or use init containers to fetch CLIs at task start (with caching). This keeps the daemon substrate-agnostic and avoids coupling.
4. **Add integration test for spend attribution in M1**: Before building the daemon, prove that the watchdog can read engagement-level spend from LiteLLM — otherwise the entire budget feature is fiction.

These changes preserve the governance layer’s value while fixing foundational flaws in the execution model. Without them, the system cannot deliver on its core promises.


---

## Functional review — `openai/gpt-5.4`

REJECT

## Summary
The roadmap is directionally aligned with the verified facts, but the deliverable still leaves key behaviors underspecified in ways that will block or distort implementation in M1–M2: especially the `ExecutionSubstrate` contract surface, handoff contract execution semantics, and budget/governance state transitions. Several roadmap items are also oversized for a personal-use-first solo project.

## Requirement Coverage: FAIL
1. **Missing explicit trace from success criteria to functional units/contracts**  
   Anchors: `docs/ROADMAP.md` M2/M3/M4, `packages/shared/src/contract.ts`, `stages.ts`, Additional Context success criteria.  
   The top-level product success criteria are covered in intent, but not fully mapped into implementable units:
   - Success criterion 1 requires **every stage plan-gated** and **every handoff contract-validated**. M2 states this, but the typed model does not represent:
     - a plan approval decision,
     - a gate timer outcome,
     - validation-required-before-advance.
   - Success criterion 2 requires overspend to halt the pipeline. M3 states watchdog behavior, but no shared/domain contract is shown for budget state, cancellation reason, or dispatch lockout.
   - Success criterion 3 requires dynamic hiring. M4 depends on “open question 1” from M1 API probe, which means the requirement is not yet decomposed into implementable FUs.  
   What a developer gets wrong: they will invent state and event models ad hoc in M1/M2, producing drift between roadmap intent and actual orchestration behavior.

2. **Open-question-dependent milestone item is being treated as planned functionality rather than a conditional branch**  
   Anchor: `docs/ROADMAP.md` M4 “Dynamic hiring … contingent on the M1 API probe”.  
   If agent/squad management endpoints are not available or not usable, M4’s requirement has no fallback functional path despite substrate swap being a hard constraint.  
   What a developer gets wrong: they may build M2/M3 with assumptions that only work if Multica supports runtime agent creation, making the design non-portable and possibly dead-ending M4.

## Acceptance Criteria: FAIL
1. **M2 acceptance is not testable as written**  
   Anchor: `docs/ROADMAP.md` M2 Acceptance.  
   “a demo idea produces a repo with passing tests where every stage was gated and every handoff contract-validated” is too broad to automate without specifying:
   - what constitutes stage completion,
   - who/what advances stage state,
   - how bounced work is retried,
   - whether one failed engagement blocks the whole stage,
   - what “queryable” means for the decisions table.  
   What a developer gets wrong: multiple incompatible implementations of orchestration are possible, all claiming compliance.

2. **M1 acceptance omits failure-path expectations for the known-untested daemon image**  
   Anchor: `docs/ROADMAP.md` M1 bullets + acceptance.  
   The happy path is clear, but this milestone exists specifically because the daemon container is a known risk. The spec does not state required observable behavior for:
   - failed `multica login --token`,
   - agent CLI missing/misconfigured,
   - proxy reachable but caching/thinking unsupported,
   - WS disconnect during task execution.  
   What a developer gets wrong: they may produce an integration test that passes once but leaves no contract for resilient behavior or diagnosis, undermining the purpose of the milestone.

3. **`HandoffContract` acceptance model is too weak to support executable validation as claimed**  
   Anchor: `packages/shared/src/contract.ts`.  
   `gherkin: string` plus `checks` does not specify:
   - how scenarios are selected/executed,
   - where commands run,
   - expected stdout/stderr behavior,
   - timeout,
   - working directory,
   - artifact existence vs content/hash/glob,
   - pass/fail mapping from Cucumber output to `failures`.  
   The docs claim “executable Gherkin” and “concrete checks”; the contract type does not let a developer implement that consistently.  
   What a developer gets wrong: contract validation will become bespoke shell scripting rather than a stable mechanism.

## Edge Cases: FAIL
1. **Fresh-context behavior is not reflected in plan/handoff design**  
   Anchors: Verified Multica facts, `docs/ROADMAP.md` M2, `StagePlan`/`EngagementPlan`.  
   Upstream verified fact: a new issue always starts a fresh LLM context. M2 mentions role-memory artifacts composed into briefs, but the contract/types do not define what mandatory context must be carried across stages/engagements.  
   What a developer gets wrong: important prior-stage decisions may not be embedded into new issues, causing avoidable context loss exactly where research says failures occur.

2. **Bounce/retry semantics are missing**  
   Anchors: D6 lifecycle text, `EngagementState` in `stages.ts`, M2 roadmap text.  
   There is a `bounced` state, but no edge behavior for:
   - max retry count,
   - whether same agent or different agent handles the bounce,
   - whether budget is decremented again,
   - whether contract can change after bounce,
   - how branch ownership behaves after failed validation.  
   What a developer gets wrong: retry loops, duplicate spend, or unsafe contract mutation.

3. **Budget boundary cases are unspecified**  
   Anchor: `docs/ROADMAP.md` M3, `budgetUsd` fields in `stages.ts`.  
   The budget model names soft/hard cap behavior, but not:
   - whether equality to hard cap stops dispatch,
   - whether in-flight tasks are cancelled immediately or only future dispatch is blocked,
   - what happens if LiteLLM spend data arrives late or differs from substrate-observed task completion,
   - rounding/precision for USD values.  
   What a developer gets wrong: inconsistent enforcement and flaky overspend tests.

4. **One-open-engagement-per-agent invariant is not represented in the shared plan model**  
   Anchors: CLAUDE.md DDD invariants, `stages.ts`.  
   Since M2 uses a fixed four-role team and M4 hires dynamically, assignment collisions are realistic. The plan types do not reserve an agent identity or encode assignment constraints.  
   What a developer gets wrong: orchestrator logic will discover conflicts too late, after dispatch planning.

## Contracts: FAIL
1. **Published contracts are under-typed for a “published language” that must support substrate swap**  
   Anchors: CLAUDE.md on `@guild/shared`, `contract.ts`, `stages.ts`.  
   `authoredBy: string`, `role: string`, `checkedAt: string`, `engagementId: string`, `projectId: string` etc. are unconstrained primitives. For internal code this might be tolerable, but this package is explicitly the published language across contexts and adapters. Missing at minimum:
   - identifier format/opacity expectations,
   - ISO-8601 requirement for timestamps,
   - non-negative/precision constraints for `budgetUsd`,
   - non-empty constraints for `instructions`, `objective`, `title`.  
   What a developer gets wrong: incompatible adapter assumptions and invalid persisted state.

2. **No error contract for validation or substrate operations**  
   Anchors: `contract.ts`, M1 “adapter for verified endpoints”.  
   There is no error catalog or result shape for:
   - validation execution failure vs acceptance failure,
   - substrate auth failure,
   - unsupported endpoint capability,
   - cancel/dispatch/comment WS desync.  
   Given substrate swap is a hard constraint, adapter consumers need stable error categories.  
   What a developer gets wrong: application code will couple to Multica-specific failure text or invent errors per adapter.

3. **Contract verdict is insufficient for decision trail and bounce behavior**  
   Anchor: `ContractVerdict` in `contract.ts`.  
   `passed`, `failures`, `checkedAt` does not identify:
   - which contract version was checked,
   - which checks ran,
   - whether execution was partial,
   - where evidence/logs are stored.  
   Since decisions are append-only provenance, this is not enough to reconstruct why Guild bounced or accepted work.  
   What a developer gets wrong: they cannot build a reliable `decisions` record or audit failed validations.

## Implementability: FAIL
1. **M1 combines too many first-of-kind risks into one milestone**  
   Anchor: `docs/ROADMAP.md` M1.  
   M1 includes cluster deployment, isolated LiteLLM, custom daemon image, proxy feature verification, API/WS probing, and shared v2 contract + adapter implementation. For a solo operator, this is too coupled: if daemon packaging fails, API probing and contract shaping stall; if proxy behavior differs, adapter work may still be blocked by unrelated infra.  
   What a developer gets wrong: they will either cut corners on verification or carry unresolved assumptions into M2.

2. **“Build daemon image” is specified as a milestone deliverable without enough operational contract**  
   Anchor: `docs/ROADMAP.md` M1 “Build and end-to-end test the custom daemon container…”  
   The spec does not state image inputs/outputs that matter for implementation:
   - supported agent CLIs in scope for MVP,
   - how credentials enter at runtime,
   - writable paths/workdir expectations,
   - whether one image must contain all CLIs or a minimal subset,
   - amd64-only acceptance despite home cluster constraint.  
   What a developer gets wrong: they may build an unnecessarily large or non-reproducible image, or test the wrong runtime subset.

3. **The typed scaffold does not yet support implementing the governance loop without clarifications**  
   Anchors: `stages.ts`, `contract.ts`, M2 roadmap.  
   Missing types for:
   - gate decision,
   - approval timer state,
   - dispatch request/result,
   - validation result with evidence,
   - budget ledger events,
   - agent hiring capability detection.  
   What a developer gets wrong: they must design core domain types during implementation, meaning the functional spec is incomplete.

## Required Changes (if REJECT)
1. Add explicit functional decomposition/tracing from the three PRODUCT success criteria to concrete M1–M4 functional units, including any conditional branches when Multica capability probes fail.
2. Split M1 into at least: (a) substrate/daemon proof, and (b) shared contract + adapter shaping, or otherwise define clear exit criteria per risk so partial success still informs design.
3. Expand `HandoffContract` and `ContractVerdict` to specify execution semantics needed for consistent implementation: command environment, timeout, cwd/workspace, artifact check semantics, evidence/log references, and distinction between validation failure and validator execution error.
4. Add shared/domain contract types for governance decisions: plan approval, gate timer expiry, dispatch outcome, bounce/retry outcome, budget enforcement event, and cancellation reason.
5. Specify bounce/retry rules in M2/D6: whether contracts are immutable after dispatch, who may amend them, retry limits, budget impact, and branch/agent reassignment behavior.
6. Define budget boundary semantics in M3: equality behavior at thresholds, in-flight cancellation policy, rounding/precision, and source-of-truth ordering when spend telemetry lags.
7. Add the minimum mandatory handoff/context payload required when creating a fresh Multica issue, so upstream decisions survive the known fresh-context reset.
8. Define stable error categories on the `ExecutionSubstrate`/validation boundary so application code does not depend on Multica-specific error text.
9. Narrow the daemon image MVP scope explicitly for personal-use-first scale: which runtimes are required in M1, amd64-only, and runtime credential/workdir assumptions.

## Top issues ranked by severity
1. **Executable handoff contracts are not actually specified enough to execute consistently**  
   Sections: `packages/shared/src/contract.ts`, D6 mechanics.  
   This is the product core. Right now the type says “executable Gherkin,” but gives only raw string + loose checks. That will fragment into ad hoc validators.

2. **Core governance state is missing from the typed scaffold**  
   Sections: `packages/shared/src/stages.ts`, M2/M3 acceptance.  
   The roadmap depends on approvals, bounces, validation, and budget halts, but the published language models only stage/engagement basics.

3. **M4 depends on an unresolved substrate capability without a fallback design**  
   Sections: M1 API probe, M4 dynamic hiring.  
   This is a real contradiction risk with the hard substrate-swap constraint. If live agent creation is unavailable, the roadmap currently just hopes it exists.

4. **Budget enforcement semantics are too vague for deterministic implementation**  
   Sections: M3, `budgetUsd` fields.  
   Since overspend halt is a success criterion, threshold and telemetry behavior must be exact.

5. **M1 is over-packed for a solo operator**  
   Section: M1.  
   Too many unrelated unknowns in one milestone weakens the learning value of the milestone.

## Enhancement proposals that fit the constraints
1. **Add a capability matrix artifact as the output of M1**  
   For each verified/failed Multica capability: issue ops, WS events, comment routing assumptions, cancellation behavior, agent/squad management, daemon packaging. This is lightweight and directly supports the substrate-swap rule.

2. **Use a minimal validator contract in MVP instead of full generic Gherkin execution**  
   For personal-use-first scale, constrain M2 contracts to:
   - one feature file path or inline scenario set,
   - shell checks with timeout/cwd,
   - artifact existence/content checks,
   - explicit evidence capture.  
   Keep it simple but typed. Don’t promise more generality than you will implement.

3. **Predeclare fallback for M4: “dynamic hiring” can mean selecting from a pre-registered idle pool if API creation is unsupported**  
   This fits Multica’s known registry model and preserves the product outcome without depending on uncertain endpoints.

4. **Represent money as integer cents or decimal string, not JS number**  
   Small change, high value. It avoids avoidable budget enforcement bugs.

5. **Define a required “engagement brief” payload type in `shared`**  
   Include prior decisions, constraints, artifact refs, and contract ref. This directly addresses fresh-context loss.

## What is over-engineered for this project’s scale
1. **Supporting both in-cluster and external datastores from day one for all three apps**  
   Section: M1 dual-mode datastores.  
   Documenting both is reasonable, but implementing both paths early is probably excessive for solo personal use. The external mode can stay documented-only until M3 unless a real user need appears.

2. **gVisor hardening in M3 before proving the conductor loop’s value**  
   Section: M3 hardening.  
   Useful eventually, but likely premature relative to validating governance behavior.

3. **Publishing the daemon image as reusable OSS in M3**  
   Section: M3.  
   Nice if it falls out naturally, but not core to Guild’s MVP success criteria.

## What is missing that will hurt in the next two milestones
1. **A capability/fallback design for dynamic hiring**  
   This will haunt M1 findings and M2 type design if not addressed now.

2. **A concrete decision/event model**  
   M2 needs approvals, validations, bounces, and dispatch outcomes represented explicitly.

3. **Validation evidence model**  
   Without it, the `decisions` table in M2 will be weak and hard to query meaningfully.

4. **Context-carryover contract for fresh issues**  
   Multica resets context per new issue; Guild needs a formal brief payload before M2 starts.

5. **Failure-path acceptance for substrate/daemon proof**  
   Otherwise M1 can “pass” without answering the risky questions it was created to answer.

Decision: REJECT — core governance and contract behaviors are still underspecified enough to cause divergent implementations in M1–M2.


---

## Security review — `kwaipilot/kat-coder-pro-v2`

REJECT

VERDICT RATIONALE:
The design contains multiple critical security gaps that would allow a compromised or malicious LLM-generated code execution path to escape containment, exfiltrate secrets, and compromise the entire home cluster. The daemon container — the least trusted component — has no runtime sandbox in M1-M2, holds git credentials, and can reach external networks, creating an unrestricted attack surface. Budget enforcement relies on an unverified LiteLLM supply chain that the design itself acknowledges was compromised in March 2026.

CRITICAL VULNERABILITIES:

1. **CRITICAL** — Daemon container runs LLM-generated code with zero sandboxing in M1-M2 (docs/ARCHITECTURE.md: "gVisor at M3"). An attacker controlling model output (via prompt injection or model compromise) can execute arbitrary code on the host node, access all cluster secrets, and pivot to other namespaces. The design explicitly defers the only containment mechanism (gVisor) to M3.

2. **CRITICAL** — Daemon holds git credentials (docker/daemon/README.md) and has unrestricted egress to git hosts + external networks during M1-M2. Compromised code can exfiltrate these credentials and push malicious commits to product repos, poisoning the supply chain for all downstream consumers.

3. **CRITICAL** — LiteLLM gateway is a known supply-chain risk (design cites March 2026 compromise) yet is the sole holder of all provider API keys. A compromised gateway instance exposes all model credentials and can intercept/modify all agent-model traffic.

4. **HIGH** — No network policies in M1-M2 (docs/ARCHITECTURE.md: "Dev mode runs in isolated namespaces WITHOUT gVisor/NetworkPolicies"). Daemon can reach Guild Postgres, Multica Postgres, and the operator's entire cluster network, enabling lateral movement after code execution.

5. **HIGH** — Multica daemon token stored as K8s Secret (docs/ARCHITECTURE.md) but no mechanism to scope its permissions. A compromised daemon can create arbitrary Multica agents, issues, and tasks, effectively hijacking the entire execution substrate.

6. **HIGH** — Contract validation runs in the conductor's environment (docs/OVERVIEW.md: F6 "run HandoffContract in Guild's own environment") but the conductor shares the cluster with the daemon. Code execution escape from the daemon compromises the validator.

7. **MEDIUM** — No integrity verification for daemon image contents. The custom image (multica binary + 14+ CLIs) is built by Guild but no signature verification or SBOM validation is described, creating a supply-chain attack vector at build time.

8. **MEDIUM** — Budget enforcement reads spend from LiteLLM (docs/OVERVIEW.md: F7) but Multica's own cost recording is explicitly unenforced (UPSTREAM FACTS). A compromised gateway can lie about spend, bypassing the kill-switch.

OWASP FINDINGS:

1. **Broken Access Control** — FINDING: Daemon has unrestricted cluster access in M1-M2; no RBAC scoping described for the daemon's service account. The daemon can access all namespaces, secrets, and persistent volumes.

2. **Cryptographic Failures** — FINDING: Git credentials stored in K8s Secrets (docker/daemon/README.md) with no encryption-at-rest mentioned; provider API keys in LiteLLM config with no key rotation mechanism.

3. **Injection** — FINDING: Agent CLIs receive issue content as prompt input (docs/OVERVIEW.md: F3 "brief = instructions + contract"). No input sanitization against prompt injection that could compromise the model or exfiltrate via model responses.

4. **Insecure Design** — FINDING: The entire execution model assumes code execution in an unsandboxed container (M1-M2) is acceptable for a "personal use" system. This contradicts the threat model of running untrusted LLM output.

5. **Security Misconfiguration** — FINDING: Dev mode explicitly disables all hardening (gVisor, NetworkPolicies) until M3. The design treats a home cluster as inherently trusted, ignoring that compromised code can reach any service on the network.

6. **Vulnerable and Outdated Components** — FINDING: LiteLLM is acknowledged as having a supply-chain compromise (March 2026) yet remains the sole key holder. No version pinning strategy or delayed upgrade scanning is described beyond D2's general statement.

7. **Software and Data Integrity Failures** — FINDING: No verification that the daemon image matches its intended contents. No SBOM, signature verification, or reproducible build process described for the custom daemon image.

8. **Security Logging and Monitoring Failures** — FINDING: No security event logging described for daemon container escapes, network policy violations, or credential access. The `decisions` table captures governance events but not security events.

9. **Server-Side Request Forgery (SSRF)** — FINDING: Daemon can make arbitrary outbound HTTP requests (to git hosts, LiteLLM, and any external endpoint). No egress filtering in M1-M2 allows SSRF to internal cluster services or external attacker infrastructure.

AUTHENTICATION/AUTHORIZATION:
- No authentication between conductor and Multica backend beyond a PAT token (docs/ARCHITECTURE.md: "PAT auth"). No mutual TLS, no per-engagement token scoping.
- Daemon authenticates to Multica with a single token that grants full access to all agent operations.
- No RBAC described for K8s service accounts; the daemon likely runs as a cluster-admin equivalent to access all required resources.
- Git credentials are shared across all engagements — no per-engagement or per-agent scoping.

DATA HANDLING:
- Provider API keys stored only in LiteLLM config (CLAUDE.md guardrail) but no encryption-at-rest or key rotation described.
- Git credentials mounted into daemon pods — accessible to any process in the container, including compromised LLM-generated code.
- Multica token stored as K8s Secret — accessible to any pod with the right service account.
- No PII handling described, but model traffic (potentially containing sensitive code) passes through LiteLLM with no TLS verification details.

INPUT VALIDATION:
- Issue content (instructions + contract) passed directly to agent CLIs as prompt input — no sanitization against prompt injection.
- Contract validation runs Gherkin scenarios and command exit codes — but the validator environment shares the cluster with the untrusted daemon, breaking isolation.
- No validation of daemon image contents before deployment.

REMAINING RISKS (if this design were approved as-is):
- The M1-M2 development window creates a permanent "temporary" insecure baseline that may ship to users who follow the docs.
- Multica's license review process (D8) is manual and error-prone — no automated license compliance checking.
- The operator is the only non-automated authority, but the CLI approval path has no MFA or secondary confirmation for destructive actions (budget kill-switch, stage acceptance).
- No disaster recovery for Guild Postgres — governance provenance is append-only but not backed up.

RECOMMENDATIONS:

**CRITICAL — Fix before M1:**
1. Enable gVisor (or equivalent sandbox) for daemon pods from day one, not M3. If the daemon image is untested, test it in a sandboxed environment first. Running untrusted LLM output without containment is unacceptable regardless of deployment scale.
2. Implement NetworkPolicies from day one: daemon egress limited to Multica backend, LiteLLM, and specific git hosts (not arbitrary IPs). Deny all inter-namespace traffic by default.
3. Scope the Multica daemon token to minimal required permissions (read tasks, post comments, update status) — not full agent management.
4. Use per-engagement git credentials (short-lived deploy keys) instead of shared credentials.

**HIGH — Fix before M2:**
5. Replace LiteLLM with a gateway that has no known supply-chain compromises, or implement integrity verification (cosign signatures, SBOM validation) for the LiteLLM image before every deployment.
6. Implement mutual TLS between conductor and Multica backend, and between conductor and LiteLLM.
7. Add security event logging: daemon container escapes, network policy denials, credential access attempts.
8. Validate and sanitize all issue content before passing to agent CLIs to mitigate prompt injection.

**MEDIUM — Address by M3:**
9. Implement K8s RBAC with least-privilege service accounts for each component.
10. Add image signature verification for the daemon image and all critical dependencies.
11. Implement per-engagement budget tokens in LiteLLM to prevent spend spoofing.
12. Add backup/restore for Guild Postgres with encryption.

DECISION: REJECT — The design defers all meaningful containment (gVisor, NetworkPolicies) to M3 while running untrusted LLM-generated code from M1, creating an unacceptable attack surface even for personal use.
