# syntax=docker/dockerfile:1
# Guild-built Multica daemon image — spec in ./README.md.
# amd64-only for M1; Claude Code is the only bundled agent CLI (MVP scope).
# Both binaries are pinned as build args and their autoupdaters disabled:
# this image + the control-plane tag are a lockstep pair.
FROM node:22-bookworm-slim

ARG MULTICA_VERSION=v0.4.15
ARG CLAUDE_CODE_VERSION=2.1.220

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl jq procps \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && claude --version

# No self-updates inside a pinned image; no update-check traffic.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

RUN set -eux; \
    ver="${MULTICA_VERSION#v}"; \
    curl -fsSL "https://github.com/multica-ai/multica/releases/download/v${ver}/multica-cli-${ver}-linux-amd64.tar.gz" \
      | tar -xz -C /usr/local/bin multica; \
    chmod 755 /usr/local/bin/multica; \
    multica --version

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh \
    && useradd -m -u 1001 agent

USER agent
WORKDIR /home/agent

# Credentials arrive at runtime via env (compose/.env) — never baked in.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
