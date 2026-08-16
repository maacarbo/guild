#!/bin/sh
# Guild daemon entrypoint: headless token login, then the daemon as PID 1
# (compose runs us under --init, so signals reach the daemon).
set -eu

: "${MULTICA_SERVER_URL:?MULTICA_SERVER_URL is required}"
: "${MULTICA_DAEMON_TOKEN:?MULTICA_DAEMON_TOKEN is required}"
MULTICA_APP_URL="${MULTICA_APP_URL:-$MULTICA_SERVER_URL}"

git config --global user.name "${GIT_USER_NAME:-guild-daemon}"
git config --global user.email "${GIT_USER_EMAIL:-guild-daemon@localhost}"
git config --global init.defaultBranch main

# HTTPS git auth for the scratch/target repos. The credential store lives in
# the container's ephemeral filesystem only.
if [ -n "${GITHUB_TOKEN:-}" ]; then
    printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > "$HOME/.git-credentials"
    chmod 600 "$HOME/.git-credentials"
fi

# Per-project git credential by NAME-indirection (#6, D17): the helper is a
# tracked, tested artifact baked into the image — see
# docker/daemon/guild-git-cred.sh and tools/checks/guild-git-cred.test.ts.
git config --global credential.helper /usr/local/bin/guild-git-cred

multica config set server_url "$MULTICA_SERVER_URL"
multica config set app_url "$MULTICA_APP_URL"

# Interactive login opens a browser; --token is the headless path.
multica login --token "$MULTICA_DAEMON_TOKEN"

exec multica daemon start --foreground
