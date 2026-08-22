import { describe, expect, it } from "vitest";
import { newestOnlineRuntime } from "./runtime-selection.js";

const row = (id: string, status: string, lastSeen?: string, name = "Opencode (guild-daemon-1)") => ({
  id,
  status,
  name,
  ...(lastSeen ? { last_seen_at: lastSeen } : {}),
});

describe("newestOnlineRuntime (#70: a dead daemon's row stays 'online' through its heartbeat grace window)", () => {
  it("prefers the most recently seen online row, whatever the list order", () => {
    const stale = row("rt-stale", "online", "2026-08-22T10:00:00Z");
    const fresh = row("rt-fresh", "online", "2026-08-22T10:05:00Z");
    expect(newestOnlineRuntime([stale, fresh])?.id).toBe("rt-fresh");
    expect(newestOnlineRuntime([fresh, stale])?.id).toBe("rt-fresh");
  });

  it("ignores offline rows and rows outside the name prefix", () => {
    const offline = row("rt-off", "offline", "2026-08-22T11:00:00Z");
    const foreign = row("rt-claude", "online", "2026-08-22T11:00:00Z", "Claude (elsewhere)");
    const ours = row("rt-ours", "online", "2026-08-22T09:00:00Z");
    expect(newestOnlineRuntime([offline, foreign, ours], "Opencode")?.id).toBe("rt-ours");
  });

  it("a row without last_seen_at sorts oldest — never preferred over a heartbeating one", () => {
    const unseen = row("rt-unseen", "online");
    const seen = row("rt-seen", "online", "2026-08-22T00:00:01Z");
    expect(newestOnlineRuntime([unseen, seen])?.id).toBe("rt-seen");
    // but it still wins over nothing
    expect(newestOnlineRuntime([unseen])?.id).toBe("rt-unseen");
  });

  it("returns undefined when no online row matches", () => {
    expect(newestOnlineRuntime([row("rt-off", "offline", "2026-08-22T11:00:00Z")])).toBeUndefined();
    expect(newestOnlineRuntime([])).toBeUndefined();
  });
});
