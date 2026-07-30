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
    git config --global credential.helper "store --file=$HOME/.git-credentials"
    printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > "$HOME/.git-credentials"
    chmod 600 "$HOME/.git-credentials"
fi

multica config set server_url "$MULTICA_SERVER_URL"
multica config set app_url "$MULTICA_APP_URL"

# Interactive login opens a browser; --token is the headless path.
multica login --token "$MULTICA_DAEMON_TOKEN"

exec multica daemon start --foreground
