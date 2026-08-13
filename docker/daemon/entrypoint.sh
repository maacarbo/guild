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

# Per-project git credential by NAME-indirection (#6, D17): the conductor's
# per-engagement custom_env names WHICH of this container's env vars holds the
# project's token (GUILD_GIT_CRED=GUILD_GIT_TOKEN_<PROJECT>); the token VALUE
# never transits Guild. The name is agent-reachable input, so it is validated
# against a strict A-Z0-9_ shape before any expansion — anything else falls
# through to the ambient store (the bootstrap PAT above), which also covers
# unconfigured projects. Username per host: GUILD_GIT_CRED_USERNAME (default
# x-access-token works for GitHub tokens; GitLab project access tokens accept
# any non-empty username).
cat > "$HOME/.guild-git-cred.sh" <<'HELPER'
#!/bin/sh
op="$1"
if [ "$op" = "get" ] && [ -n "${GUILD_GIT_CRED:-}" ]; then
    case "$GUILD_GIT_CRED" in
        *[!A-Z0-9_]* | [0-9]*) ;; # invalid name shape — never eval it
        *)
            tok=$(eval "printf %s \"\${$GUILD_GIT_CRED:-}\"")
            if [ -n "$tok" ]; then
                printf 'username=%s\n' "${GUILD_GIT_CRED_USERNAME:-x-access-token}"
                printf 'password=%s\n' "$tok"
                exit 0
            fi
            ;;
    esac
fi
exec git credential-store --file="$HOME/.git-credentials" "$op"
HELPER
chmod 755 "$HOME/.guild-git-cred.sh"
git config --global credential.helper "$HOME/.guild-git-cred.sh"

multica config set server_url "$MULTICA_SERVER_URL"
multica config set app_url "$MULTICA_APP_URL"

# Interactive login opens a browser; --token is the headless path.
multica login --token "$MULTICA_DAEMON_TOKEN"

exec multica daemon start --foreground
