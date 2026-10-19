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

describe("SERVICE_RUNNER_DATA_DIR", () => {
  it("overrides the data dir for isolated instances", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(mkdtempSync(join(tmpdir(), "sr-data-")), "data");
    const prev = process.env.SERVICE_RUNNER_DATA_DIR;
    process.env.SERVICE_RUNNER_DATA_DIR = dir;
    try {
      assert.equal(dataDir(), dir);
      assert.equal(configPath(), join(dir, "config.json"));
    } finally {
      if (prev === undefined) delete process.env.SERVICE_RUNNER_DATA_DIR;
      else process.env.SERVICE_RUNNER_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
