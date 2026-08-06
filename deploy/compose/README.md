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
  connection, and `guild init` creates the team — issue #16).
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

| Component | Pin | Where |
|---|---|---|
| Multica control plane | `v0.4.15` | `.env` `MULTICA_VERSION` |
| Multica CLI (in daemon image) | `0.4.15` | build arg `MULTICA_VERSION` |
| OpenCode CLI (in daemon image, sole runtime — D9 as amended 2026-08-04) | `1.18.10` | build arg `OPENCODE_VERSION` |
| LiteLLM | `v1.94.0` by digest `sha256:5287…b1e906` | `docker-compose.yml` |
| Postgres (Multica) | `pgvector/pgvector:pg17` | upstream requirement |
| Postgres (LiteLLM, Guild) | `postgres:17` | `docker-compose.yml` |

The Multica control-plane tag and the daemon image are a **lockstep pair**:
bump both together and run the substrate conformance suite green before either
moves (docker/daemon/README.md).

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

Record the outcome in the bump commit message. Last review: `v0.4.15`
(2026-07-30) — LICENSE identical to the version frozen in
`docs/research/multica-investigation-2026-07-29.md`.

Then bump `MULTICA_VERSION` in `.env`/`.env.example`, rebuild the daemon image,
and run the conformance suite (M1b+) before deploying.

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
