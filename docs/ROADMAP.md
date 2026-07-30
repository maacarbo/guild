# Guild — Roadmap

*Repositioned 2026-07-29 (see ARCHITECTURE.md D8). The original six-milestone platform roadmap is in git history; milestones below supersede it.*

## M0 — Foundations ✅

Original scaffold, ecosystem validation of D1–D7, multica research, reposition decision, this roadmap. All evidence in `docs/` and `docs/research/`.

## M1 — Substrate proven

Nothing in Guild matters if the substrate assumptions don't hold; prove them first. Restructured 2026-07-30 (external review: too many first-of-kind risks in one lump) into **two phases with separate exit criteria**, so a failure in one doesn't stall the other and partial success still informs design.

### M1a — Substrate & infrastructure proof

- **Deploy Multica directly with `kubectl`/`helm` into a dedicated dev namespace** — operator's call (2026-07-30): app-first speed during development, GitOps only at the last stage. Dev namespaces stay outside Flux's purview; the cluster's Flux-only rule continues to bind everything Flux already manages. Pinned chart version; record the LICENSE-diff review procedure with the pin.
- **Full isolation — test like a new user**: zero pre-existing homelab services — not the shared LiteLLM, not `dbsrv01`, not the Ollama VMs.
- Datastores: **in-cluster mode implemented** (Multica pgvector Postgres, LiteLLM DB, Guild Postgres; documented PVCs on `nfs-filesrv02`, sized generously — no volume expansion); **external mode documented-only** (connection-string/values overrides, one DB + role per app, pgvector noted) and first exercised at the M3 promotion.
- **Dev-mode hardening from day one** (external review): deny-by-default NetworkPolicies (daemon egress: Multica backend, gateway, declared git hosts), non-privileged service accounts, scoped `mdt_` daemon token where sufficient; check gVisor availability on the Talos nodes — adopt now if present, else mandatory at M3.
- **Dev gateway: isolated LiteLLM instance**, cloud routes only (`anthropic/*`, optionally OpenRouter), own in-cluster DB for virtual keys/spend; local-model backends documented as an option. Port-forward exposure only.
- **Build and e2e-test the custom daemon container** against the live backend — **image scope: Claude Code only** (amd64, credentials at runtime): headless `multica login --token`, claims and completes a real task, pushes an engagement branch to a scratch GitHub repo (open question 3 resolution).
- Gateway verification **at the gateway, not through the black-box daemon**: prompt caching and extended thinking observably work via LiteLLM logs/headers.
- **Spend-attribution proof**: mint a per-engagement virtual key, run a task through it, read attributable spend back — one mechanism proven end to end before any watchdog code exists.
- API probe on the cluster instance: issue create/assign/comment/**cancel — including verifying that cancel actually kills the forked CLI process and stops gateway traffic**, WS events, PAT auth, and the agent/squad management endpoints (open question 1).

**M1a exit criteria:** each probe/build item has a recorded pass/fail **capability matrix** (`docs/research/`), including explicit failure-path behavior: failed token login, missing CLI, proxy-unsupported features, WS disconnect mid-task. A failed item with a documented workaround still exits; an untested item does not.

### M1b — Contracts & adapter shaping

- `packages/shared` v2 contracts (governance events, contract execution semantics, substrate error categories — landed 2026-07-30) refined against the M1a capability matrix
- `substrate-multica` adapter for the verified endpoints, TDD per CLAUDE.md with the `ExecutionSubstrate` port contract-test suite; adapter errors mapped to the stable `SubstrateErrorCategory` set

**M1b exit criteria (= M1 acceptance):** a Guild integration test creates an issue via the port on the cluster instance, a containerized daemon agent completes it, the engagement branch lands in the scratch repo, comment/status events arrive over WS, and the spend appears in LiteLLM **attributed to the engagement's virtual key** — all scripted, no manual steps.

## M2 — Core governance loop

- Stage planner: idea → staged plan (analysis → architecture → implementation → test → delivery) with roles and budget allocation
- Plan-approval gate via CLI — explicit approval by default, auto-approve timer as per-project opt-in (open question 2: decide comment-mirror UX from use)
- Bounce/retry per D6 rules: contracts immutable after dispatch, same agent+issue on bounce, `MAX_BOUNCES` then operator escalation; typed engagement briefs carry prior decisions across the fresh-context reset
- Contracted dispatch: one Multica issue per engagement, `HandoffContract` (executable Gherkin + checks) authored upstream
- Guild-run contract validation on completion; bounce with failing criteria on the same issue; Guild-mediated merges, single-writer per engagement
- Fixed starter team of four roles; role-memory artifacts composed into engagement briefs

**Acceptance:** a demo idea produces a repo with passing tests where every stage was gated and every handoff contract-validated — zero un-contracted advances; the run's decision trail is queryable from Guild's `decisions` table.

## M3 — Budget enforcement + Kubernetes

- Budget watchdog: per-engagement soft cap (warn) and per-project hard cap (cancel via substrate + stop dispatch), metered from the LiteLLM gateway
- Complete and harden the in-cluster stack running since M1: Guild conductor Deployment joins the control plane; daemon Deployment hardened (`runtimeClassName: gvisor` — benchmark I/O first, NetworkPolicy with DNS scoped to the cluster resolver, token via Secret); LiteLLM hardened per D2 (pinned digest, dedicated namespace, non-privileged SA)
- Publish the daemon image build as reusable open source (upstream contribution candidate)
- **GitOps promotion — the last stage for infrastructure**: commit the proven stack to `home-lab/k8s-cluster` as Flux-managed resources (Multica `HelmRelease` + `HelmRepository`, daemon Deployment, Guild conductor, ESO-backed secrets), making the deferred calls here: Multica Postgres final placement (`dbsrv01` per house rule vs. documented in-cluster exception), exposure/DNS, and gateway topology (fold Guild's routes into the shared LiteLLM vs. keep the separate instance). Remove all ad-hoc dev resources after cutover.

**Acceptance:** Flux reconciles the whole stack from git on a clean cluster + the M2 flow entirely in-cluster; an induced overspend halts the pipeline cleanly with a visible explanation; zero ad-hoc resources remain.

## M4 — Team evolution

- Dynamic hiring: Guild creates/configures Multica agents and squads on demand from role templates (contingent on the M1 API probe; **pre-declared fallback**: selection from a pre-registered idle pool of role agents if runtime creation is unusable — same outcome, known-supported mechanics)
- Role-template registry + capability selection as data; retire idle agents
- Role-memory artifact maintenance across engagements

**Acceptance:** during a run, a role not present at project start is hired because the plan demanded it, completes contracted work, and is retired — all visible on the Multica board.

## Parked (from the original roadmap)

- Runtime/model adapter expansion — Multica owns runtimes now (14+ CLIs shipped)
- Own UI, own skills catalog — Multica's board and Agent Skills marketplace
- Enterprise hardening (RBAC/SSO, multi-tenant budgets) — out of scope for personal/non-commercial use; would also cross Multica's license line for hosted use
