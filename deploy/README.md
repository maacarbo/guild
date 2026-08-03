# deploy/ — Deployment options

Guild is built to be installable by anyone. The full stack is the same everywhere — Multica control plane (backend, frontend, Postgres/pgvector), LiteLLM gateway (+ key/spend DB), the Guild daemon container, the Guild conductor (+ Postgres), and ephemeral validator sandboxes — deployable at two tiers, lowest barrier first. (The author's hardened cluster, formerly "Tier 3", moved to a personal, non-normative runbook — see the footnote at the end.)

## Tier 1 — Docker Compose (the floor: any machine with Docker)

- Everything as compose services; Multica officially supports compose self-hosting.
- Validator sandboxes run as ephemeral `docker run` containers — the conductor's validator runner has a Docker driver alongside the K8s Job driver (same image, same zero-credentials contract).
- Requirements: Docker + Compose, provider API key(s), a git host token and a product repo. **No Kubernetes anywhere.**
- This is also M1's capability-proof vehicle and the M1–M3 shipping target: the quickstart compose *is* the stack our own milestones exercise — it can't rot into aspirational documentation.
- **Delivered at M1** (accepted 2026-07-31) — [`compose/`](compose/README.md) is the runnable quickstart and the primary dev and shipping target through M3; `v0.1.0` (M2) and the feature-complete `v0.2.0` (M3, team evolution) ship on this tier.

### Security floor — what Tier 1 does and does not provide (the primary deployment until further notice, team evolution included)

Guild's daemon executes LLM-generated code inside standard (runc) containers on your machine. **What this tier provides:** container isolation with non-root users, no host mounts into agent-reachable containers, segmented compose networks (agents reach only the Multica backend and the LiteLLM gateway; no database publishes a port — the M1–M2a dev-era loopback publish of guild-postgres closed when the conductor shipped as a compose service at M2b; the host-side dev harness re-adds it only via the explicit `docker-compose.dev.yml` override, never in the base file), dropped capabilities + `no-new-privileges`, and memory/pids limits on daemon and validator containers. **What this tier does NOT provide:** kernel-level sandboxing (a container escape is host compromise), egress control (a prompt-injected agent can send anything it can read — including its git token and Multica daemon token — to any host on the internet, and can push to any repo its git token reaches), and enforced registry-only egress for the validator sandbox (a documented D6 deviation). **Blast radius is bounded economically and procedurally, not by the network:** provider API keys never leave the gateway; every engagement key is minted with a hard `max_budget` the gateway itself enforces; plans require explicit approval before any spend; merges are Guild-mediated and fast-forward-only to the validated SHA. Run Guild on a machine, and with a git credential, you are prepared to lose: use a **fine-grained PAT scoped to the product repo(s) only** — ideally under a dedicated account/org. Plaintext `.env` secrets on a single host are part of this accepted posture. Kernel sandboxing (gVisor/Kata) and FQDN egress allowlists exist only in the Kubernetes tier; if you need them, that tier is the migration path.

## Tier 2 — Any Kubernetes (k3s, kind, managed cloud, …) — optional, last

- Plain manifests (Helm later if demand exists) with **only vanilla assumptions**: any default StorageClass — or external datastores via the dual-mode design (connection-string overrides, one DB + one role per app, pgvector required for Multica); Secrets created with plain `kubectl` under the normative names below (any secrets operator can render the same names); validator sandboxes as K8s Jobs.
- **Recommended where the infrastructure supports it, never assumed**: deny-by-default NetworkPolicies for the daemon namespace (FQDN-based egress if the CNI can do it), RuntimeClass sandboxing (gVisor/Kata) for daemon + validator pods, `automountServiceAccountToken: false` + PSA `restricted` everywhere. Where an environment can't provide one of these, that's a documented residual risk, not a broken install.
- Nothing assumes a specific CNI, storage driver, ingress controller, or GitOps tooling.
- *(planned: `k8s/` manifests land at the optional M4 — only if a recorded need exists, after the full product (through team evolution, M3) ships on Tier 1)*

## Dev/new-user secrets flow (normative names, all tiers)

Secrets are created directly by the operator — gitignored `.env` files (`chmod 600`) on Tier 1, the primary path; `kubectl create secret generic --from-env-file=...` on Tier 2; this **is** the supported path. Only **two values are user-typed external credentials** — one model-provider API key and the scoped git PAT. The recommended provider key is `OPENROUTER_API_KEY` (D9: one key reaches Claude and the cheap testing tier through the gateway; the entire M1a proof ran on it); `ANTHROPIC_API_KEY` is optional, for the direct Anthropic route. The rest is **any long random string** (documented — no generator dependency, so no Unix-only tooling in the quickstart), or minted after Multica boots (`mul_`/`mdt_` — a documented ordering step, not a surprise; the PAT comes from Multica's UI, the virtual key from LiteLLM's admin UI). Setup automation is deliberately minimal (cross-platform ruling, 2026-07-31): compose verbs only, plus the one-shot **doctor** service (`docker compose run --rm doctor`) that diagnoses a broken stack — every failure names the prerequisite, the fix, and the owning secret. The M2 `guild` CLI absorbs setup as `guild init`. Names are normative so any later secrets operator (e.g. External Secrets Operator) is a source swap, not a rename:

| Secret | Component | Keys |
|---|---|---|
| `multica-app` | Multica backend | backend config (JWT secret, DB creds) |
| `guild-daemon` | daemon | `MULTICA_DAEMON_TOKEN` (`mul_…` personal access token — the live-verified path, M1a P2/P3; the narrower workspace-scoped `mdt_` token was not exercised in M1a and is an M1b follow-up), git credentials (fine-grained HTTPS PAT scoped to the product repo(s) only), agent-CLI env |
| `litellm-app` | gateway | `ANTHROPIC_API_KEY` (+ optional OpenRouter), master key, DB creds |
| `guild-conductor` | conductor | Multica PAT (`mul_…`), LiteLLM admin key (key minting), Guild PG creds |

Env-files live outside the repo (gitignored pattern documented per Secret); no registry pull-secret needed while images are public.

## Storage ground rules

Generic (all tiers): every Postgres is **single replica** with a `Recreate`-style update policy — never two writers on one volume; back up what matters (Guild PG governance provenance, LiteLLM spend records) — a nightly `pg_dump` is enough at this scale; agent workspaces default to ephemeral (`emptyDir` / anonymous volumes) — losing a session on restart is a survivable, priced event (bounce comments are self-contained).

Tier 1 backup vehicle: nightly `pg_dump` via host cron or a scheduler container, from M2 onward; Tier 2 uses a CronJob.

---

*Footnote: the author's hardened-cluster worked example (Flux, Cilium `toFQDNs`, gVisor on Talos, ESO, NFS specifics) lives in a personal, non-normative runbook: [`docs/runbooks/authors-cluster.md`](../docs/runbooks/authors-cluster.md). Required for nobody; the product never depends on it.*
