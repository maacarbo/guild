#!/bin/sh
# Per-project git credential helper by NAME-indirection (#6, D17), installed
# into the daemon image (spec: tools/checks/guild-git-cred.test.ts).
#
# The conductor's per-engagement custom_env names WHICH of this container's
# env vars holds the project's token (GUILD_GIT_CRED=GUILD_GIT_TOKEN_<PROJ>);
# the token VALUE never transits Guild. The name is agent-reachable input:
# only names under the GUILD_GIT_TOKEN_ prefix with a clean [A-Z0-9_] shape
# are ever expanded — a merely well-shaped name is NOT a safe name (an agent
# naming PATH or MULTICA_DAEMON_TOKEN would otherwise exfiltrate it as a git
# password; audit verify sh-0). Everything else falls through to the ambient
# store (the bootstrap PAT the entrypoint seeds), which also covers
# unconfigured projects.
#
# GET-ONLY (audit clean-0): the ambient store is entrypoint-seeded and never
# runtime-written. Delegating `store` would copy per-project tokens into the
# shared file; delegating `erase` would let a 401 on a stale token delete the
# bootstrap entry for every later engagement. Both succeed as no-ops.
#
# Host scoping (audit clean-1): GUILD_GIT_CRED_HOST, when set beside the
# token name, pins the token to exactly that request host (case-insensitive;
# include the port for non-default ports); any other host falls through to
# the ambient store, so a GitLab-minted token is never offered to github.com.
# Unset means unscoped — single-host deployments keep working unchanged.
# Boundary: bracketed IPv6 literal remotes cannot be scoped (leave unset).
#
# Username per host: GUILD_GIT_CRED_USERNAME (default x-access-token works
# for GitHub tokens; GitLab project access tokens accept any non-empty name).
op="$1"
[ "$op" = "get" ] || exit 0
nl='
'
# git writes the request first — key=value lines up to a blank terminator.
# Read it before answering: the host decides scoping, and the fallthrough
# must re-feed the consumed request to credential-store.
req=""
host=""
while IFS= read -r line; do
    [ -n "$line" ] || break
    req="$req$line$nl"
    case "$line" in host=*) host="${line#host=}" ;; esac
done
if [ -n "${GUILD_GIT_CRED:-}" ]; then
    case "$GUILD_GIT_CRED" in
        *[!A-Z0-9_]*) ;;       # invalid name shape — never eval it
        GUILD_GIT_TOKEN_?*)    # allowlisted prefix + non-empty suffix, clean chars proven above
            tok=$(eval "printf %s \"\${$GUILD_GIT_CRED:-}\"")
            case "$tok" in *"$nl"*) tok="" ;; esac # a newline is protocol injection, not a token
            # case-insensitive: DNS names are, and git forwards the remote
            # URL's casing verbatim (verified against git 2.43) — a literal
            # compare would silently disable a case-mismatched scope
            if [ -n "${GUILD_GIT_CRED_HOST:-}" ] &&
                [ "$(printf %s "$host" | tr 'A-Z' 'a-z')" != "$(printf %s "$GUILD_GIT_CRED_HOST" | tr 'A-Z' 'a-z')" ]; then
                tok="" # scoped token, foreign host — the ambient store answers instead
            fi
            if [ -n "$tok" ]; then
                printf 'username=%s\n' "${GUILD_GIT_CRED_USERNAME:-x-access-token}"
                printf 'password=%s\n' "$tok"
                exit 0
            fi
            ;;
        *) ;; # on-shape but outside the token namespace (PATH, HOME, …) — never expand
    esac
fi
printf %s "$req" | git credential-store --file="$HOME/.git-credentials" get
