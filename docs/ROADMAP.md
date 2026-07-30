# Guild — Roadmap

*Repositioned 2026-07-29 (see ARCHITECTURE.md D8). The original six-milestone platform roadmap is in git history; milestones below supersede it.*

## M0 — Foundations ✅

Original scaffold, ecosystem validation of D1–D7, multica research, reposition decision, this roadmap. All evidence in `docs/` and `docs/research/`.

## M1 — Substrate proven

Nothing in Guild matters if the substrate assumptions don't hold; prove them first. Restructured 2026-07-30 (external review: too many first-of-kind risks in one lump) into **two phases with separate exit criteria**, so a failure in one doesn't stall the other and partial success still informs design.

### M1a — Substrate proof (split 2026-07-30, Anthropic review: prove behavior on the workstation first, lift to the cluster second)

#### M1a-0 — Capability proof (docker-compose on the workstation — no cluster dependency)

Everything the capability matrix needs can be proven against a compose stack; cluster infra adds nothing to these answers:

- Compose stack: pinned Multica + isolated LiteLLM; scratch GitHub repo
- Daemon container e2e (Claude Code only, amd64, creds at runtime): claims + completes a task, pushes an engagement branch
- Gateway proofs: prompt caching + extended thinking via LiteLLM logs/headers; **virtual key minted with `max_budget` stops serving at cap** — record how the 429 classifies in Multica
- Spend attribution: per-engagement key → task → attributable spend read back
- API probes: issue create/assign/comment/cancel; **cancel kills the forked CLI and stops gateway traffic**; WS events (+ REST read endpoints for reconciliation); **does a top-level conductor-PAT comment trigger the implementing agent** (bounce delivery — currently unverified and load-bearing); **do replies on closed issues still enqueue tasks** (termination protocol); **does bounce survive a daemon restart** (continuity floor); agent/squad management endpoints (**best-effort** — the idle-pool fallback stands either way)

#### M1a-1 — Cluster lift

- Lift the proven compose stack into the isolated dev namespaces; re-validate the transport rows of the matrix (WS behavior through the cluster network, PVC-backed workspaces)
- Hardening: deny-by-default **CiliumNetworkPolicy with `toFQDNs`** for git hosts + the mandatory DNS-proxy rule (**probe: L7 DNS policy actually active**); non-privileged SAs with `automountServiceAccountToken: false`; PSA `restricted` namespace labels; scoped `mdt_` token
- gVisor per the Talos reality (schematic extension on one labeled worker + RuntimeClass + nodeSelector + smoke test) — start it, don't block on it
- Dev secrets flow per `deploy/README.md` (the documented new-user path — ESO is barred by the isolation rule)
- NFS/Postgres checks: single-replica `Recreate` for every PG, sync export + hard mounts (or node-local for dev), nightly `pg_dump` CronJob for Guild PG + LiteLLM DB; agent workspaces default to `emptyDir` (resume loss is a survivable, priced event)

#### Standing M1a rules (both phases)

- **Dev mode** — operator's call (2026-07-30): direct `kubectl`/`helm`, GitOps only at the last stage; dev namespaces outside Flux's purview; the cluster's Flux-only rule binds everything Flux already manages. Pinned Multica version everywhere (compose and cluster); record the LICENSE-diff review procedure with the pin.
- **Full isolation — test like a new user**: zero pre-existing homelab services — not the shared LiteLLM, not `dbsrv01`, not the Ollama VMs. Dev gateway = isolated LiteLLM, cloud routes only, own DB for virtual keys/spend; local-model backends documented as an option. Port-forward exposure only.
- Datastores: **in-cluster mode implemented** (Multica pgvector Postgres, LiteLLM DB, Guild Postgres; documented PVCs on `nfs-filesrv02`, sized generously — no volume expansion); **external mode documented-only** and first exercised at the M3 promotion.

**M1a exit criteria:** every probe/build item above has a recorded pass/fail entry in the **capability matrix** (`docs/research/`), including explicit failure-path behavior: failed token login, missing CLI, proxy-unsupported features, WS disconnect mid-task. A failed item with a documented workaround still exits; an untested item does not.

### M1b — Contracts & adapter shaping

- `packages/shared` v2 contracts (governance events, contract execution semantics, substrate error categories, port reads/rework/close — landed 2026-07-30) refined against the M1a capability matrix
- `substrate-multica` adapter for the verified endpoints, TDD per CLAUDE.md with the `ExecutionSubstrate` port contract-test suite; adapter errors mapped to the stable `SubstrateErrorCategory` set; the suite doubles as the **substrate conformance suite** — mandatory-green on every Multica pin bump and daemon image rebuild
- **First proof of the core mechanism**: validate a hand-written `HandoffContract` against the branch the integration test produced (SHA-pinned, validator-Job pattern) — the differentiator gets its first demonstration here, not in M2

**M1b exit criteria (= M1 acceptance):** a Guild integration test creates an issue via the port on the cluster instance, a containerized daemon agent completes it, the engagement branch lands in the scratch repo, comment/status events arrive over WS, the spend appears in LiteLLM **attributed to the engagement's virtual key**, and a hand-written contract validates against the produced branch. **"Scripted, no manual steps" means: one idempotent entrypoint run over standing infrastructure** — it may assume the dev stack exists; it may not assume any prior test state.

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

**M2 acceptance:** a demo idea produces a repo with passing tests where every stage was gated and every handoff contract-validated — zero un-contracted advances; the run's decision trail is queryable from Guild's `decisions` table.

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
