/**
 * Runtime-row selection (#70): after a daemon container recreate, the dead
 * container's row stays `online` through its heartbeat grace window, so
 * "first online row" can bind an agent to a corpse whose tasks queue
 * forever. The newest heartbeat is the live daemon; a row that never
 * heartbeated sorts oldest.
 */

export interface RuntimeRow {
  id: string;
  status: string;
  name?: string;
  last_seen_at?: string;
}

export function newestOnlineRuntime<R extends RuntimeRow>(rows: readonly R[], namePrefix?: string): R | undefined {
  return rows
    .filter((r) => r.status === "online" && (!namePrefix || (r.name ?? "").startsWith(namePrefix)))
    .sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""))[0];
}
