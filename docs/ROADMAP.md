# Guild — Roadmap

*Repositioned 2026-07-29 (see ARCHITECTURE.md D8). The original six-milestone platform roadmap is in git history; milestones below supersede it.*

## M0 — Foundations ✅

Original scaffold, ecosystem validation of D1–D7, multica research, reposition decision, this roadmap. All evidence in `docs/` and `docs/research/`.

## M1 — Substrate proven

Nothing in Guild matters if the substrate assumptions don't hold; prove them first.

- **Deploy Multica directly with `kubectl`/`helm` into a dedicated dev namespace** — operator's call (2026-07-30): app-first speed during development, GitOps only at the last stage. Dev namespaces stay outside Flux's purview, so nothing is pruned or reverted; the cluster's Flux-only rule continues to bind everything Flux already manages. Pinned chart version; record the LICENSE-diff review procedure with the pin.
- **Full isolation — test like a new user** (operator decision 2026-07-30): the dev stack uses **zero pre-existing homelab services** — not the shared LiteLLM, not `dbsrv01`, not the Ollama VMs. Everything Guild needs ships in its own dev namespaces.
- **Dual-mode datastores, both documented from day one**: the deploy supports (a) **in-cluster** datastores — Multica's Postgres (pgvector), LiteLLM's key/spend DB, and Guild's Postgres as K8s instances with documented PVCs (on this cluster: `nfs-filesrv02`, sized generously — volume expansion is disabled) — this is the dev default; and (b) **external** datastores — documented connection-string/values overrides, one DB + one role per app, pgvector requirement for Multica called out. The M3 promotion picks the permanent mode; both stay supported for other users.
- **Dev gateway: an isolated LiteLLM instance in the dev namespace**, cloud routes only by default (`anthropic/*`, optionally OpenRouter) with its own in-cluster DB for virtual keys/spend; local-model backends (e.g. Ollama) are a documented option, not a dependency. Exposure via port-forward / internal Gateway IP only.
- **Build and end-to-end test the custom daemon container against the live cluster backend** (the known-untested piece): multica binary + agent CLIs + git, headless `multica login --token`, claims and completes a real task
- Verify LiteLLM routing from inside the daemon container (`ANTHROPIC_BASE_URL`): **acceptance test — prompt caching and extended thinking work through the proxy** (carried from old D2)
- Probe the API surface against the cluster instance: issue create/assign/comment/cancel, WebSocket events, PAT auth, and the **agent/squad management endpoints (open question 1)**
- `packages/shared` v2 contracts + `substrate-multica` adapter for the verified endpoints, TDD per CLAUDE.md with a port contract-test suite

**Acceptance:** a Guild integration test creates an issue via the port on the cluster instance, a containerized daemon agent completes it, the comment/status events arrive over WS, and the spend appears in LiteLLM — all scripted, no manual steps.

## M2 — Core governance loop

- Stage planner: idea → staged plan (analysis → architecture → implementation → test → delivery) with roles and budget allocation
- Plan-approval gate via CLI with bounded auto-approve timer (open question 2: decide comment-mirror UX from use)
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

- Dynamic hiring: Guild creates/configures Multica agents and squads on demand from role templates (contingent on the M1 API probe)
- Role-template registry + capability selection as data; retire idle agents
- Role-memory artifact maintenance across engagements

**Acceptance:** during a run, a role not present at project start is hired because the plan demanded it, completes contracted work, and is retired — all visible on the Multica board.

## Parked (from the original roadmap)

- Runtime/model adapter expansion — Multica owns runtimes now (14+ CLIs shipped)
- Own UI, own skills catalog — Multica's board and Agent Skills marketplace
- Enterprise hardening (RBAC/SSO, multi-tenant budgets) — out of scope for personal/non-commercial use; would also cross Multica's license line for hosted use
