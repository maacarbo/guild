# deploy/ — Deployment options

Guild is built to be installable by anyone; the author's home cluster is only the **reference environment**. The full stack is the same everywhere — Multica control plane (backend, frontend, Postgres/pgvector), LiteLLM gateway (+ key/spend DB), the Guild daemon container, the Guild conductor (+ Postgres), and ephemeral validator sandboxes — deployable at three tiers, lowest barrier first.

## Tier 1 — Docker Compose (the floor: any machine with Docker)

- Everything as compose services; Multica officially supports compose self-hosting.
- Validator sandboxes run as ephemeral `docker run` containers — the conductor's validator runner has a Docker driver alongside the K8s Job driver (same image, same zero-credentials contract).
- Requirements: Docker + Compose, provider API key(s), a git host token and a product repo. **No Kubernetes anywhere.**
- This is also M1a-0's capability-proof vehicle: the shipped quickstart compose *is* the stack our own milestone exercises — it can't rot into aspirational documentation.
- *(planned: `compose/` lands in M1 — the primary dev and shipping target through M2; `v0.1.0` ships on this tier)*

## Tier 2 — Any Kubernetes (k3s, kind, managed cloud, …)

- Plain manifests (Helm later if demand exists) with **only vanilla assumptions**: any default StorageClass — or external datastores via the dual-mode design (connection-string overrides, one DB + one role per app, pgvector required for Multica); Secrets created with plain `kubectl` under the normative names below (any secrets operator can render the same names); validator sandboxes as K8s Jobs.
- **Recommended where the infrastructure supports it, never assumed**: deny-by-default NetworkPolicies for the daemon namespace (FQDN-based egress if the CNI can do it), RuntimeClass sandboxing (gVisor/Kata) for daemon + validator pods, `automountServiceAccountToken: false` + PSA `restricted` everywhere. Where an environment can't provide one of these, that's a documented residual risk, not a broken install.
- Nothing assumes a specific CNI, storage driver, ingress controller, or GitOps tooling.
- *(planned: `k8s/` manifests land at M3 — after the application ships functionally on Tier 1)*

## Tier 3 — Hardened reference (the author's cluster — a worked example, required for nobody)

One concrete instance of Tier 2 with every recommendation turned on, so the hardening advice has a proven implementation: Flux GitOps (M3 promotion), Cilium `toFQDNs` egress + mandatory DNS-proxy rule (CIDR allowlists rejected as unmaintainable), gVisor via Talos system extension on labeled workers, ESO→Bitwarden secrets rendering the same normative Secret names, NFS-backed PVCs with the storage ground rules below.

## Dev/new-user secrets flow (normative names, all tiers)

Secrets are created directly by the operator (`kubectl create secret generic --from-env-file=...`, or `.env` files in Tier 1); this **is** the supported path. Names are normative so any later secrets operator (Tier 3 uses ESO) is a source swap, not a rename:

| Secret | Component | Keys |
|---|---|---|
| `multica-app` | Multica backend | backend config (JWT secret, DB creds) |
| `guild-daemon` | daemon | `MULTICA_DAEMON_TOKEN` (`mdt_…`), git credentials (HTTPS token), agent-CLI env |
| `litellm-app` | gateway | `ANTHROPIC_API_KEY` (+ optional OpenRouter), master key, DB creds |
| `guild-conductor` | conductor | Multica PAT (`mul_…`), LiteLLM admin key (key minting), Guild PG creds |

Env-files live outside the repo (gitignored pattern documented per Secret); no registry pull-secret needed while images are public.

## Storage ground rules

Generic (all tiers): every Postgres is **single replica** with a `Recreate`-style update policy — never two writers on one volume; back up what matters (Guild PG governance provenance, LiteLLM spend records) — a nightly `pg_dump` is enough at this scale; agent workspaces default to ephemeral (`emptyDir` / anonymous volumes) — losing a session on restart is a survivable, priced event (bounce comments are self-contained).

Reference-environment specifics (Tier 3, NFS): sync export + hard mounts for database PVCs or use node-local storage for dev databases; size PVCs up front — the reference storage class has volume expansion disabled.
