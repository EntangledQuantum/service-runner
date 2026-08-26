import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dataDir, logsDir, configPath, sanitizeIdForPath } from "./paths.ts";

describe("data dir", () => {
  it("lives under LocalAppData, not the git repo", () => {
    const dir = dataDir();
    assert.match(dir, /ServiceRunner$/);
    assert.ok(dir.toLowerCase().includes("appdata"), dir);
    assert.ok(!dir.toLowerCase().includes("service_creator"));
    assert.ok(configPath().endsWith("config.json"));
    assert.ok(logsDir().endsWith("logs"));
  });
  it("sanitizes ids for filesystem paths", () => {
    assert.equal(sanitizeIdForPath("life-os"), "life-os");
    assert.equal(sanitizeIdForPath("a/b"), "a_b");
  });
});
