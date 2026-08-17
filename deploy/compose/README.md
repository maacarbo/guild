# Guild — Tier 1 Docker Compose stack

The fully-isolated dev/quickstart stack: Multica control plane (execution
substrate), LiteLLM gateway (metering + budget caps), Guild's conductor
database, and the Guild-built Multica daemon container. This directory **is**
the shipped Tier 1 deliverable (deploy/README.md); the M1a capability proof
runs on exactly this stack.

Requirements: Docker with Compose v2, amd64 (the daemon image is amd64-only
for M1 — docker/daemon/README.md).

## Quickstart

Works identically on Windows, macOS, and Linux — the only prerequisite is
Docker with Compose v2; every command below is a compose verb (no `make`, no
host shell scripts).

**1. Configure.** Copy `.env.example` to `.env` and fill it in. Only two
values are external credentials you must obtain: a model-provider key
(`OPENROUTER_API_KEY` recommended) and a scoped GitHub PAT. Every other
secret is **any long random string** — use your password manager's generator
(or `openssl rand -hex 32` if you have it; the tool doesn't matter).

**2. Boot the control plane.**

```
docker compose up -d
```

**3. Create the workspace and mint the gateway key** (both need the control
plane up):

- Multica UI at http://localhost:3000 — log in (dev stack: the fixed
  verification code from `.env`) and create a workspace; put its id in `.env`
  as `GUILD_WORKSPACE_ID`. **First login shows Multica's own onboarding —
  tutorials, a questionnaire, "connect local agents" prompts. Skip it all:
  none of it applies under Guild** (the daemon container *is* the agent
  connection, and `guild init` creates the team — issue #16). This only
  happens on the visit *before* `guild init`: init pre-marks the operator,
  conductor, and daemon accounts onboarded, so later logins go straight to
  the board.
- LiteLLM admin UI at http://localhost:4000/ui — log in with
  `LITELLM_MASTER_KEY`, create a virtual key **with a `max_budget`** → paste
  into `.env` as `GUILD_DAEMON_VIRTUAL_KEY`.

You no longer hand-mint the daemon's Multica PAT here — `guild init` mints it in
the next step, as a dedicated **non-governance** identity (D15 / #17 A5d): the
daemon runs LLM-generated code, so its credential must never resolve to the
operator.

**4. Initialize Guild** (M2b — the governance layer itself):

```
docker compose run --rm guild-init
```

It provisions **three distinct Multica member identities** — the operator, the
conductor (its own PAT, so a Guild move is never mistaken for a human one), and
`daemon@guild.local` (what the LLM-running daemon authenticates as, deliberately
NOT the operator — D15/#17 A5d) — plus the fixed four-role starter team, and
prints every generated value. Paste them into `.env`:

- conductor: `GUILD_MULTICA_TOKEN`, `GUILD_WORKSPACE_ID`, `GUILD_ROLE_AGENTS`,
  `GUILD_OPERATOR_MEMBER_IDS` (the allowlist), `GUILD_DAEMON_MEMBER_ID`
- daemon: `MULTICA_DAEMON_TOKEN`

Then set `GUILD_REPO_URL` (HTTPS with the scoped PAT embedded).

**5. Start the daemon and the conductor.**

```
docker compose --profile daemon up -d --build
docker compose --profile conductor up -d --build
```

**6. Verify.**

```
docker compose run --rm doctor
```

Doctor checks the whole chain (env → control plane → gateway → model route →
daemon credentials → registered runtime) — including that the daemon identity is
**distinct from the operator** (D15 A5d) — and, on any failure, prints the
broken prerequisite, the fix, and which `.env` secret owns it. One boundary:
if a *core* secret is missing entirely, Compose itself refuses to start
anything — including doctor — with a `required variable <NAME> is missing`
error; that error names the variable, so it is the diagnosis (set it in
`.env` and re-run). Reset everything with `docker compose --profile "*" down -v` and
replay the quickstart (the `--profile "*"` matters: profile-gated services
like the daemon and conductor survive a plain `down` and would keep running
against the wiped databases — found live during the v0.1.0 replay).

**7. Run the known-good demo.** Mint an operator PAT for yourself (Settings →
API Tokens) into `.env` as `GUILD_OPERATOR_TOKEN`, then:

```
docker compose run --rm guild-demo
```

It posts the demo idea as a board ticket; the conductor answers with a
plan-approval ticket per stage. Everything after that happens on the board:
move a plan ticket to *Ready to work* to approve, comment `amend: <note>` to
revise, move a validated stage ticket to *Done* to accept. The emergency
stop is `docker compose run --rm guild-kill` — it cancels in-flight work,
revokes keys, and locks dispatch until you raise the caps in `.env` and
restart the conductor.

The daemon registers one runtime row per bundled CLI (sidebar: Configure → Runtimes;
OpenCode — the sole runtime, D9 as amended 2026-08-04), labeled by
`$MULTICA_DAEMON_DEVICE_NAME`. All agent model traffic flows
`CLI → litellm:4000 → provider`, authenticated by the virtual key — never a
provider key — so every call is metered and hard-capped (`max_budget`).
OpenCode agents use `provider/model`-qualified models against the baked
`litellm` provider (e.g. `litellm/or-claude-haiku-4-5`).

### Upgrading a `v0.1.1` install to `v0.2.0` (M3 team evolution)

Non-breaking. Pull the new images and restart — the conductor applies its
additive schema migrations (role memory, run rules pin, terminal spend) at
startup:

```bash
git checkout v0.2.0
docker compose -f docker-compose.yml pull guild-conductor guild-daemon
docker compose -f docker-compose.yml --profile daemon --profile conductor up -d
```

Optional new configuration: `GUILD_AGENT_MODEL` (the model route runtime-hired
agents bind to; defaults to the gateway's cheap tier).

### Upgrading a `v0.1.0` install to `v0.1.1` (D15 daemon identity)

`v0.1.0` had the operator hand-mint `MULTICA_DAEMON_TOKEN` from their own
account, so the daemon authenticated **as the operator** — an agent that reached
that token could forge operator board moves (#17 A5c/A5d/A5e, advisory
`GHSA-7pg8-mmpv-r6pc`). To upgrade:

1. Update your checkout to `v0.1.1` (`git pull` / `git checkout v0.1.1`) so the
   compose files default `GUILD_IMAGE_TAG` to `v0.1.1` (or export
   `GUILD_IMAGE_TAG=v0.1.1`), then re-run `docker compose run --rm guild-init`.
   It now also mints `daemon@guild.local` and prints `MULTICA_DAEMON_TOKEN`,
   `GUILD_OPERATOR_MEMBER_IDS`, and `GUILD_DAEMON_MEMBER_ID`.
2. Replace the old hand-minted `MULTICA_DAEMON_TOKEN` in `.env` with the printed
   one, and add the two new conductor vars. Recreate the daemon and conductor:
   `docker compose --profile daemon --profile conductor up -d --force-recreate`.
3. Run `docker compose run --rm doctor` — check `[5/7]` must report the daemon
   identity as distinct from the operator.

The conductor **refuses to start** if `GUILD_OPERATOR_MEMBER_IDS` is empty,
contains its own id, or contains `GUILD_DAEMON_MEMBER_ID` — so a half-applied
upgrade fails loudly, never silently. Role agents survive the daemon token
re-mint only if the daemon's `daemon_id` is stable (a persistent
`~/.multica/daemon.id`); on the default volume-less dev daemon the id churns, so
re-running `guild init` re-registers the team (research addendum P30). You may
also revoke the operator's old hand-minted daemon PAT after the cutover.

## Version pins

**`versions.env` in this directory is the single source of truth for the
pins the release watcher and the bump procedure touch** (#14): Multica
version, OpenCode version, and the LiteLLM / socket-proxy image digests.
Base and database images are pinned directly where they are used — the table
below lists all of them. The compose interpolation defaults and the
daemon-image ARG defaults mirror it, and a CI-enforced unit test
(`tools/checks/versions-file.test.ts`) fails the build
on any disagreement — README, compose, and image can never silently drift.

| Component | Pin lives in | Mirrored where |
|---|---|---|
| Multica control plane + CLI (lockstep pair) | `versions.env` `MULTICA_VERSION` | compose defaults, daemon build arg |
| OpenCode CLI (daemon image, sole runtime — D9 as amended 2026-08-04) | `versions.env` `OPENCODE_VERSION` | compose default, daemon build arg |
| LiteLLM (by image digest) | `versions.env` `LITELLM_IMAGE_DIGEST` | `docker-compose.yml` |
| Docker socket proxy (by image digest) | `versions.env` `SOCKET_PROXY_IMAGE_DIGEST` | `docker-compose.yml` |
| Postgres (Multica) | `pgvector/pgvector:pg17` | upstream requirement |
| Postgres (LiteLLM, Guild) | `postgres:17` | `docker-compose.yml` |
| Validator sandbox (`GUILD_VALIDATOR_IMAGE`) | `node:22-alpine` default | `docker-compose.yml`, `.env.example`, conductor fallback |
| Daemon / conductor base images | `node:22-bookworm-slim` / `node:22-alpine` | `docker/daemon/Dockerfile`, `docker/conductor/Dockerfile` |
| Doctor base image | `alpine:3.22` | `deploy/compose/doctor/Dockerfile` |

The Multica control-plane tag and the daemon image are a **lockstep pair**:
bump both together and run the substrate conformance suite green before either
moves (docker/daemon/README.md). A scheduled release watcher
(`.github/workflows/multica-release-watcher.yml`) opens the bump PR with the
LICENSE diff and release notes attached — it never merges anything.

## Multica pin-bump procedure (license + behavior)

Multica is source-available with an internal-use carve-out (ARCHITECTURE.md
D8). On every pin bump, **before** changing `MULTICA_VERSION`:

```bash
git clone --depth 1 https://github.com/multica-ai/multica /tmp/multica-pin
cd /tmp/multica-pin
git fetch --depth 1 origin tag vNEW && git fetch --depth 1 origin tag vOLD
git diff vOLD vNEW -- LICENSE        # empty = no license change; anything else
                                     # → stop and review before bumping
```

Record the outcome in the bump commit message. Last review: `v0.4.26`
(2026-08-16/17, PR #47) — SUBSTANTIVE rewrite into the two-part "Multica
License" (Part I additional conditions + verbatim Apache 2.0): new
attribution condition for non-UI products, hosted-service restriction
explicit even free of charge, broader UI definition, whole-file
redistribution rule. Reviewed and **accepted by the operator 2026-08-17**;
full analysis on PR #47. Guild's posture unaffected (self-hosted, single
org, unmodified UI, attribution already in README/PRODUCT). Prior review:
`v0.4.15` (2026-07-30) — identical to the version frozen in
`docs/research/multica-investigation-2026-07-29.md`.

Then bump `MULTICA_VERSION` in `versions.env` (and its mirror locations — the
CI versions-file test names any you miss), rebuild the daemon image, and run
the conformance suite (M1b+) before deploying. The release watcher's PR does
the mechanical half of this for you; the review and the conformance run remain
yours.

## Per-project git credentials (D17)

The daemon's ambient PAT is the bootstrap credential. To scope a project's
git access to exactly its repos (#6):

1. **Mint a repo-scoped token** on the host: GitLab — a project access token
   (API-mintable: `POST /projects/:id/access_tokens` with an operator token);
   GitHub — a fine-grained PAT restricted to the project's repos (UI-minted;
   a GitHub App installation token is the automatable path if you run one).
2. **Give it to the daemon by name**: add e.g. `GUILD_GIT_TOKEN_MYPROJ` to the
   daemon service's environment via a compose override file (value in `.env`,
   name in the override — never in tracked files).
3. **Point the conductor at the name**: set `GUILD_GIT_CRED_NAME=GUILD_GIT_TOKEN_MYPROJ`
   in the conductor's env. The name must live in the `GUILD_GIT_TOKEN_`
   namespace with a non-empty `[A-Z0-9_]` suffix — the daemon's helper
   allowlists exactly that prefix (a well-shaped name outside it, like
   `PATH`, is agent-nameable and must never be expanded), and the conductor
   refuses anything else at startup because the helper would otherwise
   silently fall back to the ambient PAT. Every engagement's
   `custom_env` then carries `GUILD_GIT_CRED=<that name>`, and the daemon
   image's credential helper (`docker/daemon/guild-git-cred.sh` — get-only,
   spec in `tools/checks/guild-git-cred.test.ts`) resolves it at git time
   (falling back to the ambient store when unset — unconfigured projects keep
   working). Optionally set `GUILD_GIT_CRED_HOST=<host[:port]>` beside the
   name to pin the token to one request host (#56, case-insensitive): any
   other host falls through to the ambient store, so a multi-host daemon
   never offers one host's token to another. (Bracketed IPv6 literal
   remotes cannot be scoped — leave the host unset for those.) For GitLab set `GUILD_GIT_CRED_USERNAME` on the
   daemon if your setup needs a specific username; the default
   `x-access-token` suits GitHub.
4. **Revoke** = revoke on the host + drop the env var; other projects are
   untouched. Note the honest boundary (ARCHITECTURE.md D17): projects
   sharing one daemon container share its env — intra-daemon isolation needs
   a daemon service per project.

## Isolation

This stack talks only to: its own containers, GitHub (git + API for the
scratch/target repos), and the configured model provider(s). It uses **zero**
pre-existing services on the host or network — "test like a new user."

## Storage

Named volumes (`multica_pgdata`, `multica_uploads`, `litellm_pgdata`,
`guild_pgdata`) per the ground rules in deploy/README.md. The daemon container
deliberately has **no** volume: session/workdir state is ephemeral, and bounce
continuity across a daemon restart is best-effort by design (bounce comments
are self-contained — ARCHITECTURE.md D6).
