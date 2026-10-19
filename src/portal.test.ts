import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { assertLoopbackOrigin } from "./security.ts";
import { HttpError } from "./types.ts";
import { assertPublish, assertPublishPath, matchesSegment } from "./portal/publish.ts";
import {
  resolveRoute,
  rewriteLocation,
  rewriteSetCookie,
  sameOriginRefererPath,
  stripHopByHop,
  stripPortalCookie,
  type RouteApp,
} from "./portal/routing.ts";
import { hashToken, LoginLimiter, readCookies, SessionStore, verifyToken } from "./portal/auth.ts";
import { resolveIcon } from "./portal/apps.ts";
import { safeJoin } from "./portal/pages.ts";

const app = (over: Partial<RouteApp>): RouteApp => ({
  id: "x",
  name: "X",
  path: "/x",
  upstream: "http://127.0.0.1:5000",
  stripPrefix: true,
  bypass: [],
  rootAliases: [],
  ...over,
});

const atlas = app({ id: "atlas", path: "/atlas", upstream: "http://127.0.0.1:5001" });
const lifeos = app({
  id: "lifeos",
  path: "/lifeos",
  upstream: "http://127.0.0.1:5002",
  bypass: ["/lifeos/api/v1", "/api/v1", "/health"],
});
const cwa = app({
  id: "cwa",
  path: "/cwa",
  upstream: "http://127.0.0.1:5003",
  stripPrefix: false,
  bypass: ["/cwa/opds"],
  rootAliases: ["/cwa-", "/magicshelf"],
});
const apps = [atlas, lifeos, cwa];

describe("portal routing", () => {
  it("reserves /_portal and the home page", () => {
    assert.equal(resolveRoute("/_portal/api/me", "", apps).kind, "portal");
    assert.equal(resolveRoute("/_portal", "", apps).kind, "portal");
    assert.equal(resolveRoute("/", "", apps).kind, "home");
    assert.equal(resolveRoute("/index.html", "", apps).kind, "home");
  });

  it("redirects the bare prefix and strips it when proxying", () => {
    assert.deepEqual(resolveRoute("/atlas", "?a=1", apps), { kind: "redirect", app: atlas, location: "/atlas/?a=1", auth: true });
    const r = resolveRoute("/atlas/assets/app.js", "?v=2", apps);
    assert.equal(r.kind, "proxy");
    if (r.kind === "proxy") {
      assert.equal(r.app.id, "atlas");
      assert.equal(r.upstreamPath, "/assets/app.js?v=2");
      assert.equal(r.auth, true);
    }
    const root = resolveRoute("/atlas/", "", apps);
    assert.ok(root.kind === "proxy" && root.upstreamPath === "/");
  });

  it("matches on segment boundaries only", () => {
    assert.equal(resolveRoute("/atlasx/y", "", apps).kind, "notfound");
    assert.equal(matchesSegment("/api/v1x", "/api/v1"), false);
    assert.equal(matchesSegment("/api/v1/a", "/api/v1"), true);
    assert.equal(matchesSegment("/api/v1", "/api/v1"), true);
  });

  it("keeps the path when stripPrefix is false", () => {
    const r = resolveRoute("/cwa/books", "", apps);
    assert.ok(r.kind === "proxy" && r.upstreamPath === "/cwa/books" && r.auth);
  });

  it("bypass skips auth, beats referer, and works at root level", () => {
    const a = resolveRoute("/api/v1/items", "?q=1", apps, { path: "/atlas/page" });
    assert.ok(a.kind === "proxy");
    if (a.kind === "proxy") {
      assert.equal(a.app.id, "lifeos");
      assert.equal(a.auth, false);
      assert.equal(a.upstreamPath, "/api/v1/items?q=1");
    }
    const b = resolveRoute("/lifeos/api/v1/x", "", apps);
    assert.ok(b.kind === "proxy" && b.auth === false && b.upstreamPath === "/api/v1/x");
    const c = resolveRoute("/lifeos/settings", "", apps);
    assert.ok(c.kind === "proxy" && c.auth === true);
    const d = resolveRoute("/cwa/opds/feed", "", apps);
    assert.ok(d.kind === "proxy" && d.auth === false && d.upstreamPath === "/cwa/opds/feed");
    assert.equal(resolveRoute("/api/v10", "", apps).kind, "notfound");
  });

  it("rootAliases forward unchanged, longest wins, auth required", () => {
    const r = resolveRoute("/cwa-static/x.css", "", apps);
    assert.ok(r.kind === "proxy" && r.app.id === "cwa" && r.upstreamPath === "/cwa-static/x.css" && r.auth);
    const longer = [app({ id: "a", path: "/a", rootAliases: ["/m"] }), app({ id: "b", path: "/b", rootAliases: ["/magic"] })];
    const l = resolveRoute("/magic/1", "", longer);
    assert.ok(l.kind === "proxy" && l.app.id === "b");
  });

  it("falls back to the same-origin Referer", () => {
    const ref = sameOriginRefererPath("https://box.example.net/atlas/page", "box.example.net");
    const r = resolveRoute("/socket.io/", "?EIO=4", apps, ref);
    assert.ok(r.kind === "proxy" && r.app.id === "atlas" && r.upstreamPath === "/socket.io/?EIO=4" && r.auth);
    assert.equal(sameOriginRefererPath("https://evil.example/atlas/page", "box.example.net"), null);
    assert.equal(resolveRoute("/socket.io/", "", apps, sameOriginRefererPath("https://box/atlas", "box")).kind, "notfound");
    assert.equal(resolveRoute("/nothing", "", apps).kind, "notfound");
  });
});

describe("publish validation", () => {
  it("accepts a sane block and normalizes the path", () => {
    const p = assertPublish({ path: "atlas/", upstream: "http://localhost:3000/" }, { reservedPorts: [4780, 4790] });
    assert.deepEqual(p, { path: "/atlas", upstream: "http://localhost:3000", stripPrefix: true });
    assert.equal(assertPublish(null, { reservedPorts: [] }), null);
  });
  it("rejects bad path segments", () => {
    for (const bad of ["/_portal", "/Atlas", "/a/b", "/", "", "/a b", "/../x"]) {
      assert.throws(() => assertPublishPath(bad), HttpError, bad);
    }
  });
  it("rejects non-loopback and reserved upstreams", () => {
    const ctx = { reservedPorts: [4780, 4790] };
    for (const up of [
      "http://192.168.1.5:3000",
      "http://example.com",
      "http://127.0.0.1:4780",
      "http://localhost:4790",
      "file:///C:/x",
      "http://user:pw@127.0.0.1:3000",
      "http://127.0.0.1:3000/sub",
      "http://127.0.0.2:3000",
    ]) {
      assert.throws(() => assertPublish({ path: "/a", upstream: up }, ctx), HttpError, up);
    }
    assert.equal(assertLoopbackOrigin("http://[::1]:8080", "u"), "http://[::1]:8080");
    assert.equal(assertLoopbackOrigin("http://127.0.0.1:8090/health", "url", [], { allowPath: true }), "http://127.0.0.1:8090/health");
  });
  it("rejects dangerous bypass/rootAliases and cross-app conflicts", () => {
    const ctx = { reservedPorts: [], others: [{ id: "atlas", publish: { path: "/atlas", upstream: "http://127.0.0.1:1", stripPrefix: true } }] };
    const base = { path: "/b", upstream: "http://127.0.0.1:2" };
    for (const bypass of [["/"], ["api"], ["/_portal/api"], ["/a/../b"], ["/atlas/api"], ["/_"]]) {
      assert.throws(() => assertPublish({ ...base, bypass }, ctx), HttpError, JSON.stringify(bypass));
    }
    assert.throws(() => assertPublish({ ...base, path: "/atlas" }, ctx), HttpError);
    assert.throws(() => assertPublish({ ...base, rootAliases: ["/_portal"] }, ctx), HttpError);
    assert.throws(() => assertPublish({ ...base, icon: "javascript:alert(1)" }, ctx), HttpError);
    assert.throws(() => assertPublish({ ...base, color: "red" }, ctx), HttpError);
    const ok = assertPublish({ ...base, bypass: ["/api/v1"], rootAliases: ["/cwa-"], icon: "📚", color: "#7c9cff" }, ctx);
    assert.deepEqual(ok?.bypass, ["/api/v1"]);
  });
  it("resolves app-relative icons under the app path", () => {
    assert.equal(resolveIcon("📚", "/atlas"), "📚");
    assert.equal(resolveIcon("https://x.example/i.png", "/atlas"), "https://x.example/i.png");
    assert.equal(resolveIcon("/favicon.svg", "/atlas"), "/atlas/favicon.svg");
    assert.equal(resolveIcon("/atlas/logo.png", "/atlas"), "/atlas/logo.png");
  });
});

describe("header rewriting", () => {
  it("rewrites Location to the public path", () => {
    assert.equal(rewriteLocation("http://127.0.0.1:5001/login?x=1", atlas), "/atlas/login?x=1");
    assert.equal(rewriteLocation("http://localhost:5001/", atlas), "/atlas/");
    assert.equal(rewriteLocation("/login", atlas), "/atlas/login");
    assert.equal(rewriteLocation("/atlas/already", atlas), "/atlas/already");
    assert.equal(rewriteLocation("next", atlas), "next");
    assert.equal(rewriteLocation("https://accounts.example.com/auth", atlas), "https://accounts.example.com/auth");
    assert.equal(rewriteLocation("http://127.0.0.1:9999/x", atlas), "http://127.0.0.1:9999/x");
    assert.equal(rewriteLocation("http://127.0.0.1:5003/cwa/x", cwa), "/cwa/x");
    assert.equal(rewriteLocation("/login", cwa), "/login");
  });
  it("rewrites Set-Cookie paths only with stripPrefix and refuses the portal cookie", () => {
    assert.equal(rewriteSetCookie("a=1; Path=/; HttpOnly", atlas), "a=1; Path=/atlas/; HttpOnly");
    assert.equal(rewriteSetCookie("a=1; path=/api", atlas), "a=1; Path=/atlas/api");
    assert.equal(rewriteSetCookie("a=1; Path=/atlas/x", atlas), "a=1; Path=/atlas/x");
    assert.equal(rewriteSetCookie("a=1; Path=/", cwa), "a=1; Path=/");
    assert.equal(rewriteSetCookie("a=1; Domain=localhost; Path=/", cwa), "a=1; Path=/");
    assert.equal(rewriteSetCookie("sr_portal=evil; Path=/", atlas), null);
  });
  it("strips the portal cookie and hop-by-hop headers", () => {
    assert.equal(stripPortalCookie("a=1; sr_portal=abc.def; b=2"), "a=1; b=2");
    assert.equal(stripPortalCookie("sr_portal=abc"), undefined);
    const h = stripHopByHop({ connection: "keep-alive, x-secret", "x-secret": "1", "keep-alive": "5", te: "trailers", host: "h", "content-type": "t" });
    assert.deepEqual(h, { host: "h", "content-type": "t" });
    assert.deepEqual(readCookies("x=1; sr_portal=a.b; sr_portal=c.d"), ["a.b", "c.d"]);
  });
});

describe("tokens and sessions", () => {
  it("hashes and verifies the access token", async () => {
    const hash = await hashToken("correct-token");
    assert.match(hash, /^scrypt\$/);
    assert.ok(!hash.includes("correct-token"));
    assert.equal(await verifyToken("correct-token", hash), true);
    assert.equal(await verifyToken("wrong-token", hash), false);
    assert.equal(await verifyToken("", hash), false);
    assert.equal(await verifyToken("correct-token", "garbage"), false);
  });

  it("creates, verifies, refreshes, expires and revokes sessions", () => {
    let days = 30;
    let changes = 0;
    const store = new SessionStore(null, () => days, () => changes++);
    const t0 = Date.now();
    const { cookie, session } = store.create({ deviceName: "Phone", userAgent: "UA", ip: "1.2.3.4" }, t0);
    assert.equal(changes, 1);
    assert.ok(store.verify(cookie, t0 + 1000));
    assert.equal(store.verify(cookie.split(".")[0] + ".wrong", t0), null);
    assert.equal(store.verify("nodot", t0), null);
    assert.equal(store.verify(undefined, t0), null);
    assert.equal(store.verify(cookie, t0 + 1000)?.refresh, null);
    const later = store.verify(cookie, t0 + 8 * 86_400_000);
    assert.equal(later?.refresh, cookie, "re-issued after 7 days");
    assert.equal(store.verify(cookie, t0 + 9 * 86_400_000)?.refresh, null);
    assert.equal(store.list()[0].id, session.id);
    assert.ok(!("secretHash" in store.list()[0]));
    days = 1;
    assert.equal(store.verify(cookie, t0 + 20 * 86_400_000), null, "expired by inactivity");
    days = 30;
    const second = store.create({ deviceName: "Laptop", userAgent: "UA", ip: "1.2.3.4" }, Date.now());
    assert.equal(store.revoke(second.session.id), true);
    assert.equal(store.verify(second.cookie), null);
    store.create({ deviceName: "A", userAgent: "", ip: "" });
    store.create({ deviceName: "B", userAgent: "", ip: "" });
    assert.equal(store.revokeAll(), 2);
  });

  it("persists sessions atomically", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sr-portal-"));
    try {
      const file = join(dir, "portal-sessions.json");
      const a = new SessionStore(file, () => 400);
      const { cookie } = a.create({ deviceName: "D", userAgent: "U", ip: "I" });
      assert.ok(!readFileSync(file, "utf8").includes(cookie.split(".")[1]), "secret is not stored");
      const b = new SessionStore(file, () => 400);
      assert.ok(b.verify(cookie));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rate limits per IP and globally", () => {
    const lim = new LoginLimiter(10, 50, 15 * 60_000);
    const t = 1_000_000;
    for (let i = 0; i < 10; i++) {
      assert.equal(lim.check("a", t), null);
      lim.fail("a", t);
    }
    const wait = lim.check("a", t + 1000);
    assert.ok(wait !== null && wait > 0 && wait <= 900);
    assert.equal(lim.check("b", t), null, "other IPs unaffected");
    assert.equal(lim.check("a", t + 15 * 60_000 + 1), null, "window slides");

    const g = new LoginLimiter(10, 50, 15 * 60_000);
    for (let i = 0; i < 50; i++) g.fail(`ip${i}`, t);
    assert.ok(g.check("fresh", t) !== null, "global cap");

    const u = new LoginLimiter(2, 50, 60_000);
    u.fail("c", t);
    const s = u.fail("c", t + 1);
    u.undo("c", s);
    assert.equal(u.check("c", t + 2), null, "success clears the IP");
  });
});

describe("portal static files", () => {
  it("blocks traversal and Windows path tricks", () => {
    const root = join("C:", "srv", "portal-web");
    assert.equal(safeJoin(root, "app.js"), join(root, "app.js"));
    assert.equal(safeJoin(root, "img/logo.svg"), join(root, "img", "logo.svg"));
    for (const bad of ["../package.json", "..%2fpackage.json", "a/../../x", "%5c..%5cx", "C:%5cWindows", "x.txt::$DATA", ".env", "", "%00", "/abs", "%E0%A4%A"]) {
      assert.equal(safeJoin(root, bad), null, bad);
    }
  });
});
