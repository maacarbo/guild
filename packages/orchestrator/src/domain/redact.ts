/**
 * Credential redaction (pure). GUILD_REPO_URL embeds the scoped git PAT
 * (https://x-access-token:<PAT>@host/...); git subprocess errors echo the
 * full command line, so any error text that might carry a URL passes through
 * here before it reaches logs or the append-only decisions table (M2b verify
 * finding: verdict details persisted the PAT in plaintext).
 */

const URL_USERINFO = /(https?:\/\/)[^/\s@]+@/g;

export function redactUrlCredentials(text: string): string {
  return text.replace(URL_USERINFO, "$1***@");
}
