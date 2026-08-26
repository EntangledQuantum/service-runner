import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { assertLocalDir, assertServiceId, looksLikeUrl, isUnc, slugify } from "./security.ts";
import { HttpError } from "./types.ts";

describe("assertServiceId", () => {
  it("accepts stable ids", () => {
    assert.equal(assertServiceId("life-os"), "life-os");
    assert.equal(assertServiceId("app_1"), "app_1");
  });
  it("rejects junk", () => {
    assert.throws(() => assertServiceId("../etc"), HttpError);
    assert.throws(() => assertServiceId(""), HttpError);
    assert.throws(() => assertServiceId("has space"), HttpError);
  });
});

describe("local-only paths", () => {
  it("rejects URLs", () => {
    assert.equal(looksLikeUrl("https://example.com/app"), true);
    assert.equal(looksLikeUrl("http://127.0.0.1:3000"), true);
    assert.equal(looksLikeUrl("E:\\My_Project\\app"), false);
    assert.throws(() => assertLocalDir("https://evil.example/app"), HttpError);
    assert.throws(() => assertLocalDir("git@github.com:x/y.git"), HttpError);
  });
  it("rejects UNC shares", () => {
    assert.equal(isUnc("\\\\server\\share\\app"), true);
    assert.throws(() => assertLocalDir("\\\\server\\share\\app"), HttpError);
  });
  it("rejects relative paths", () => {
    assert.throws(() => assertLocalDir("..\\other"), HttpError);
    assert.throws(() => assertLocalDir("./here"), HttpError);
  });
  it("accepts an existing local directory", () => {
    const windir = process.env.WINDIR || "C:\\Windows";
    if (existsSync(windir)) {
      const resolved = assertLocalDir(windir);
      assert.match(resolved, /^[A-Za-z]:\\/);
    }
  });
});

describe("slugify", () => {
  it("turns a name into an id", () => {
    assert.equal(slugify("Life OS"), "life-os");
  });
});
