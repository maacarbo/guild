#!/bin/sh
# Per-project git credential helper by NAME-indirection (#6, D17), installed
# into the daemon image (spec: tools/checks/guild-git-cred.test.ts).
#
# The conductor's per-engagement custom_env names WHICH of this container's
# env vars holds the project's token (GUILD_GIT_CRED=GUILD_GIT_TOKEN_<PROJ>);
# the token VALUE never transits Guild. The name is agent-reachable input, so
# it is validated against a strict [A-Z_][A-Z0-9_]* shape before any
# expansion — anything else falls through to the ambient store (the bootstrap
# PAT the entrypoint seeds), which also covers unconfigured projects.
#
# GET-ONLY (audit clean-0): the ambient store is entrypoint-seeded and never
# runtime-written. Delegating `store` would copy per-project tokens into the
# shared file; delegating `erase` would let a 401 on a stale token delete the
# bootstrap entry for every later engagement. Both succeed as no-ops.
#
# Username per host: GUILD_GIT_CRED_USERNAME (default x-access-token works
# for GitHub tokens; GitLab project access tokens accept any non-empty name).
op="$1"
[ "$op" = "get" ] || exit 0
if [ -n "${GUILD_GIT_CRED:-}" ]; then
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
exec git credential-store --file="$HOME/.git-credentials" get
