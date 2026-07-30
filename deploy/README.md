# deploy/

- **M1–M2 (dev mode):** direct `kubectl`/`helm` into dedicated dev namespaces on the home cluster — a **fully isolated stack, zero pre-existing services used** (test like a new user would): pinned upstream Multica chart (ships no daemon template), isolated LiteLLM with cloud routes, port-forward exposure. Dev namespaces are outside Flux's purview; **never ad-hoc-edit Flux-managed resources** (e.g. the shared `litellm` namespace) — reconciliation reverts them. docker-compose kept only as an offline fallback.
- **Datastores are dual-mode, both documented:** (a) in-cluster — Multica Postgres (pgvector), LiteLLM DB, Guild Postgres as K8s instances with documented PVCs (here: `nfs-filesrv02`; size up front, expansion disabled); (b) external — values/connection-string overrides, one DB + one role per app, pgvector requirement noted. Dev defaults to (a); promotion picks the permanent mode; both remain supported.

## Dev secrets flow (the documented new-user path — ESO is barred by the isolation rule)

Dev-namespace Secrets are created directly by the operator (`kubectl create secret generic --from-env-file=...`); this **is** the supported path for dev and for new users, not a shortcut. Required Secrets (names are normative; the M3 ExternalSecrets must render identical names so promotion is a source swap, not a rename):

| Secret | Namespace | Keys |
|---|---|---|
| `multica-app` | multica dev ns | Multica backend config (JWT secret, DB creds) |
| `guild-daemon` | multica dev ns | `MULTICA_DAEMON_TOKEN` (`mdt_…`), git credentials (HTTPS token), agent-CLI env |
| `litellm-app` | litellm dev ns | `ANTHROPIC_API_KEY` (+ optional OpenRouter), master key, DB creds |
| `guild-conductor` | guild dev ns | Multica PAT (`mul_…`), LiteLLM admin key (for key minting), Guild PG creds |

Env-files live outside the repo (gitignored pattern documented per Secret); no registry pull-secret needed while images are public — revisit if the daemon image goes private.

## NFS & Postgres ground rules (dev)

- Every Postgres: **single replica, `Recreate` strategy** — never two writers on one NFS-backed PVC.
- NFS: sync export + hard mounts for database PVCs, or use `local-path` for dev databases; **agent workspaces default to `emptyDir`** — losing a session on pod restart is a survivable, priced event (self-contained bounce comments cover it).
- Nightly `pg_dump` CronJob for Guild PG and the LiteLLM DB (governance provenance and spend records are the two things worth keeping).
- **M3 (promotion):** Guild conductor joins the cluster; daemon hardening (`runtimeClassName: gvisor`, scoped NetworkPolicy); LiteLLM hardened per D2; then the proven stack is committed to `home-lab/k8s-cluster` as Flux-managed resources and ad-hoc dev resources are removed. Topology in `docs/ARCHITECTURE.md`.
