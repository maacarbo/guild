import { describe, expect, it } from "vitest";
import { redactUrlCredentials } from "./redact.js";

describe("credential redaction (M2b verify: PATs must never reach logs or the trail)", () => {
  it("strips userinfo from embedded https URLs, keeping the rest of the message", () => {
    const msg =
      "Command failed: git clone --quiet https://x-access-token:ghp_abc123@github.com/o/r.git /tmp/x\nfatal: repo not found";
    const out = redactUrlCredentials(msg);
    expect(out).not.toContain("ghp_abc123");
    expect(out).toContain("https://***@github.com/o/r.git");
    expect(out).toContain("fatal: repo not found");
  });

  it("leaves credential-free URLs and plain text alone", () => {
    expect(redactUrlCredentials("clone of https://github.com/o/r.git failed")).toBe(
      "clone of https://github.com/o/r.git failed",
    );
    expect(redactUrlCredentials("no urls here")).toBe("no urls here");
  });
});
