# syntax=docker/dockerfile:1
# Guild-built Multica daemon image — spec in ./README.md.
# amd64-only for M1. Bundled agent CLI: OpenCode (sole runtime, D9 as amended
# 2026-08-04 — MIT-licensed, redistributable in a public image).
# All binaries are pinned as build args; autoupdates disabled (OpenCode's
# autoupdater is off in its baked config below): this image + the
# control-plane tag are a lockstep pair.
FROM node:22-bookworm-slim

ARG MULTICA_VERSION=v0.4.15
ARG OPENCODE_VERSION=1.18.10

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl jq procps \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && opencode --version

RUN set -eux; \
    ver="${MULTICA_VERSION#v}"; \
    curl -fsSL "https://github.com/multica-ai/multica/releases/download/v${ver}/multica-cli-${ver}-linux-amd64.tar.gz" \
      | tar -xz -C /usr/local/bin multica; \
    chmod 755 /usr/local/bin/multica; \
    multica --version

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh \
    && useradd -m -u 1001 agent

# OpenCode: LiteLLM declared as a custom provider; virtual key arrives at
# runtime via {env:GUILD_DAEMON_VIRTUAL_KEY} — nothing secret is baked.
COPY --chown=agent:agent opencode.json /home/agent/.config/opencode/opencode.json

USER agent
WORKDIR /home/agent

# Credentials arrive at runtime via env (compose/.env) — never baked in.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
