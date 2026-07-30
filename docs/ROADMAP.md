# Guild — Roadmap

*Repositioned 2026-07-29 (see ARCHITECTURE.md D8). The original six-milestone platform roadmap is in git history; milestones below supersede it.*

**Audience note (2026-07-30):** milestones are the **author's execution plan** — but each milestone's *deliverables* are the portable artifacts other users install: M1 ships the Tier 1 compose quickstart, M3 ships the generic Tier 2 K8s manifests (with the Tier 3 hardened bits as an overlay); M3's GitOps promotion is reference-environment-only and required for nobody. Bullets naming concrete homelab infrastructure (Talos, Cilium, NFS classes) describe the reference implementation of a generic requirement, not a product dependency.

**Sequencing decision (operator, 2026-07-30, supersedes the kubectl-dev-namespaces plan for M1–M2): simple to complex.** The full application is built, working, and **shipped on Docker Compose first** (M1–M2); Kubernetes begins only after functional completeness (M3). The governance loop is functionally identical on compose — gates, contracts, `docker run` validator sandboxes, gateway `max_budget` caps — so the cluster adds operational hardening later, never features.

## M0 — Foundations ✅

Original scaffold, ecosystem validation of D1–D7, multica research, reposition decision, this roadmap. All evidence in `docs/` and `docs/research/`.

## M1 — Substrate proven (on Docker Compose)

Nothing in Guild matters if the substrate assumptions don't hold; prove them first — entirely on the compose stack. (History: the external review split M1 into phases; the Anthropic review moved the proof to the workstation; the 2026-07-30 sequencing decision made compose the primary target through M2, moving the cluster lift to M3.)

### M1a — Capability proof

- Compose stack: pinned Multica + isolated LiteLLM; scratch GitHub repo. **Deliverable: this compose stack is the shipped Tier 1 quickstart** (`deploy/README.md`) — new users install what the milestone proves
- Daemon container e2e (Claude Code only, amd64, creds at runtime): claims + completes a task, pushes an engagement branch
- Gateway proofs: prompt caching + extended thinking via LiteLLM logs/headers; **virtual key minted with `max_budget` stops serving at cap** — record how the 429 classifies in Multica
- Spend attribution: per-engagement key → task → attributable spend read back
- API probes: issue create/assign/comment/cancel; **cancel kills the forked CLI and stops gateway traffic**; WS events (+ REST read endpoints for reconciliation); **does a top-level conductor-PAT comment trigger the implementing agent** (bounce delivery — currently unverified and load-bearing); **do replies on closed issues still enqueue tasks** (termination protocol); **does bounce survive a daemon restart** (continuity floor); agent/squad management endpoints (**best-effort** — the idle-pool fallback stands either way)

#### Standing M1–M2 rules

- **Compose-first dev** — everything runs as an isolated compose project on the workstation; no cluster dependency exists before M3. Pinned Multica version; record the LICENSE-diff review procedure with the pin.
- **Full isolation — test like a new user**: zero pre-existing homelab services — not the shared LiteLLM, not `dbsrv01`, not the Ollama VMs. Dev gateway = isolated LiteLLM, cloud routes only, own DB for virtual keys/spend; local-model backends documented as an option.
- Datastores: **containerized mode implemented** (Multica pgvector Postgres, LiteLLM DB, Guild Postgres as compose services with named volumes); **external mode documented-only** (connection-string overrides) until the M3 lift exercises it.
- Compose-era hardening floor: dedicated compose network, non-root containers, no unnecessary host mounts — with the real blast-radius bounds being the explicit-approval default and the gateway `max_budget` caps. The Kubernetes controls (NetworkPolicies, PSA, gVisor) land with the M3 lift.

**M1a exit criteria:** every probe/build item above has a recorded pass/fail entry in the **capability matrix** (`docs/research/`), including explicit failure-path behavior: failed token login, missing CLI, proxy-unsupported features, WS disconnect mid-task. A failed item with a documented workaround still exits; an untested item does not.

### M1b — Contracts & adapter shaping

- `packages/shared` v2 contracts (governance events, contract execution semantics, substrate error categories, port reads/rework/close — landed 2026-07-30) refined against the M1a capability matrix
- `substrate-multica` adapter for the verified endpoints, TDD per CLAUDE.md with the `ExecutionSubstrate` port contract-test suite; adapter errors mapped to the stable `SubstrateErrorCategory` set; the suite doubles as the **substrate conformance suite** — mandatory-green on every Multica pin bump and daemon image rebuild
- **First proof of the core mechanism**: validate a hand-written `HandoffContract` against the branch the integration test produced (SHA-pinned, validator-Job pattern) — the differentiator gets its first demonstration here, not in M2

**M1b exit criteria (= M1 acceptance):** a Guild integration test creates an issue via the port on the compose stack, a containerized daemon agent completes it, the engagement branch lands in the scratch repo, comment/status events arrive over WS, the spend appears in LiteLLM **attributed to the engagement's virtual key**, and a hand-written contract validates against the produced branch (via the `docker run` validator driver). **"Scripted, no manual steps" means: one idempotent entrypoint run over standing infrastructure** — it may assume the compose stack is up; it may not assume any prior test state.

## M2 — Core governance loop (split 2026-07-30, Anthropic review: the differentiator gets a proof point before the whole product)

### M2a — One real engagement, governed

- Hand-authored `StagePlan` (no planner yet): one stage, one role, one engagement
- Full governed path: explicit gate → saga dispatch (virtual key with `max_budget`, brief, contract) → agent works → SHA-pinned validator-Job validation → **a real bounce with a real fix** → fast-forward merge → accept → termination protocol
- Reconciliation proven: kill the conductor mid-engagement, restart, watch it recover from reads

**M2a acceptance:** one engagement completes the entire governed lifecycle including one genuine bounce-and-recover, with every transition in the `decisions` table.

### M2b — The planner and the team

- Stage planner: idea → staged plan (analysis → architecture → implementation → test → delivery) with roles and budget allocation; plan versioning + re-gate on amendment
- Plan-approval gate via CLI — explicit approval by default, auto-approve timer as per-project opt-in (open question 2: decide comment-mirror UX from use)
- Fixed starter team of four roles; multi-stage, multi-engagement orchestration (role-memory artifacts deferred wholesale to M4 — briefs carry `priorDecisions` explicitly until then)
- Budget watchdog (application code — needs no cluster): per-engagement soft cap (warn) and per-project hard cap (cancel via substrate + lock dispatch), metered from the LiteLLM gateway; an induced overspend halts the pipeline cleanly with a visible explanation

**M2 acceptance — the full application, working and shipped:** a demo idea produces a repo with passing tests where every stage was gated and every handoff contract-validated — zero un-contracted advances; the run's decision trail is queryable from Guild's `decisions` table; an induced overspend halts cleanly. **Ship it: tag `v0.1.0` and publish the Tier 1 quickstart** — anyone with Docker, API keys, and a git token can run Guild.

## M3 — Kubernetes: lift, hardening, promotion

Only after the application works. Nothing here adds a feature; everything adds an operational quality.

- Lift the proven compose stack to Kubernetes; re-validate the capability matrix's transport rows (WS through the cluster network, PVC-backed volumes). **Deliverable: the Tier 2 generic K8s manifests** — vanilla assumptions only — with the reference cluster's hardening as a separate overlay
- Hardening (reference implementations of generic requirements): deny-by-default **CiliumNetworkPolicy with `toFQDNs`** + the mandatory DNS-proxy rule (**probe: L7 DNS policy actually active**); non-privileged SAs with `automountServiceAccountToken: false`; PSA `restricted` labels; scoped `mdt_` token; gVisor per the Talos reality (schematic extension on one labeled worker + RuntimeClass + nodeSelector + smoke test), cluster-wide via the promotion runbook; LiteLLM hardened per D2
- Storage: single-replica `Recreate` for every PG, NFS ground rules per `deploy/README.md`, nightly `pg_dump` CronJob, workspaces `emptyDir`; first exercise of the external-datastore mode
- Publish the daemon image build as reusable open source (upstream contribution candidate)
- **GitOps promotion — the last stage for infrastructure**: commit the proven stack to `home-lab/k8s-cluster` as Flux-managed resources (Multica `HelmRelease` + `HelmRepository`, daemon Deployment, Guild conductor, ESO-backed secrets rendering the normative Secret names), making the deferred calls here: Multica Postgres final placement, exposure/DNS, gateway topology (fold Guild's routes into the shared LiteLLM vs. keep the separate instance). Remove all ad-hoc dev resources after cutover.

**Acceptance:** Flux reconciles the whole stack from git on a clean cluster + the M2 flow entirely in-cluster; zero ad-hoc resources remain.

## M4 — Team evolution

- Dynamic hiring: Guild creates/configures Multica agents and squads on demand from role templates (contingent on the M1 API probe; **pre-declared fallback**: selection from a pre-registered idle pool of role agents if runtime creation is unusable — same outcome, known-supported mechanics)
- Role-template registry + capability selection as data; retire idle agents
- Role-memory artifact maintenance across engagements

**Acceptance:** during a run, a role not present at project start is hired because the plan demanded it, completes contracted work, and is retired — all visible on the Multica board.

## Parked (from the original roadmap)

- Runtime/model adapter expansion — Multica owns runtimes now (14+ CLIs shipped)
- Own UI, own skills catalog — Multica's board and Agent Skills marketplace
- Enterprise hardening (RBAC/SSO, multi-tenant budgets) — out of scope for personal/non-commercial use; would also cross Multica's license line for hosted use
