# Guild conductor image (M2b ship gate: the conductor as a compose service).
# One image serves the long-running conductor AND the one-shot CLI verbs
# (guild-init / guild-demo / guild-kill) — compose picks the entrypoint.
#
# Build context is the REPO ROOT (see deploy/compose/docker-compose.yml);
# .dockerignore keeps the context small. Runs tsx directly — the workspace
# has no emit step; the image trades a dev-dependency install for zero build
# machinery (revisit if image size ever matters).

FROM node:22-alpine

# git: ff-merges, upstream-handoff reads, validator clones (D6 — the
# conductor's credentials ride in GUILD_REPO_URL, never the agents').
# docker-cli: the validator driver; reaches the API only via DOCKER_HOST
# pointed at the scoped socket proxy (raw socket mounts are forbidden).
RUN apk add --no-cache git docker-cli && npm install -g pnpm@10

WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
# the validator work root must be node-owned IN THE IMAGE: a fresh named
# volume inherits the image path's ownership on first mount — without this
# the mountpoint is root-owned and every clone fails EACCES (M2b verify,
# reproduced live)
RUN pnpm install --frozen-lockfile && chown -R node:node /app \
    && mkdir -p /var/guild/validator-work && chown -R node:node /var/guild

USER node
# run from the orchestrator package so tsx resolves from ITS node_modules
# (pnpm keeps dependencies package-local, never hoisted to the root)
WORKDIR /app/packages/orchestrator
ENTRYPOINT ["node", "--import", "tsx", "src/bin/guild-conductor.ts"]
