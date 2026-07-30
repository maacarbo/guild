# Guild — Tier 1 Docker Compose stack

The fully-isolated dev/quickstart stack: Multica control plane (execution
substrate), LiteLLM gateway (metering + budget caps), Guild's conductor
database, and the Guild-built Multica daemon container. This directory **is**
the shipped Tier 1 deliverable (deploy/README.md); the M1a capability proof
runs on exactly this stack.

Requirements: Docker with Compose v2, amd64 (the daemon image is amd64-only
for M1 — docker/daemon/README.md).

## Quickstart

```bash
cd deploy/compose
cp .env.example .env        # fill in secrets — comments say how to generate each
docker compose up -d        # control plane + gateway + guild-postgres
```

Open http://localhost:3000, log in (dev stack: fixed verification code — see
`.env.example`), then mint a personal access token (`mul_…`) and a LiteLLM
virtual key, put them in `.env` (`MULTICA_DAEMON_TOKEN`,
`GUILD_DAEMON_VIRTUAL_KEY`), and start the daemon:

```bash
docker compose --profile daemon up -d --build
```

The daemon registers as a runtime (Settings → Runtimes) whose rows are
labeled by `$MULTICA_DAEMON_DEVICE_NAME`. Agent model traffic flows
`claude → litellm:4000 → provider`, authenticated by the virtual key — never a
provider key — so every call is metered and hard-capped (`max_budget`).

## Version pins

| Component | Pin | Where |
|---|---|---|
| Multica control plane | `v0.4.15` | `.env` `MULTICA_VERSION` |
| Multica CLI (in daemon image) | `0.4.15` | build arg `MULTICA_VERSION` |
| Claude Code CLI (in daemon image) | `2.1.220` | build arg `CLAUDE_CODE_VERSION` |
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
