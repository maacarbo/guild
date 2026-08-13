import { describe, expect, it } from "vitest";
import { LIVE_TEST_DATABASE, isolatedDatabaseUrl } from "./live-db.js";

describe("live-suite database isolation (#27)", () => {
  it("rewrites the database path to the isolated test database, preserving everything else", () => {
    expect(isolatedDatabaseUrl("postgres://guild:s3cr%40t@127.0.0.1:5442/guild")).toBe(
      `postgres://guild:s3cr%40t@127.0.0.1:5442/${LIVE_TEST_DATABASE}`,
    );
  });

  it("an explicit override URL pointing at the live database still rewrites — the suite can NEVER touch it", () => {
    // GUILD_POSTGRES_URL is honored for host/credentials, never for the db name:
    // the TRUNCATE in the live suites must be structurally unable to reach the
    // reconciling conductor's database
    const url = isolatedDatabaseUrl("postgres://guild:pw@10.0.0.5:5432/guild");
    expect(url.endsWith(`/${LIVE_TEST_DATABASE}`)).toBe(true);
    expect(url).toContain("10.0.0.5:5432");
  });
});
