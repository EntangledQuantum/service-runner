// Demo server with fake data: control panel on 4799, portal on 4798 (docs/portal-spec.md).
// Used by scripts/screenshot.mjs so README images never show a real machine.
// Portal demo token: demo-access-token
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "web");
const PWEB = join(ROOT, "portal-web");
const NOPORTAL = process.env.NOPORTAL === "1";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();
const H = 3600e3;
let pidSeq = 21400;

const groups = [{ id: "web", name: "Web apps" }, { id: "infra", name: "Infra" }];
const services = [
  svc("notes", "Notes", "C:\\projects\\notes", "pnpm dev", "web", "running", 26 * H, ["http://127.0.0.1:5173"], { path: "/notes", upstream: "http://127.0.0.1:5173", stripPrefix: false, title: "Notes", description: "Quick notes and journal", icon: "📝", color: "#f6b04d", order: 10, bypass: ["/notes/api/v1"], rootAliases: [] }),
  svc("atlas", "Atlas Maps", "C:\\projects\\atlas", "python -m uvicorn app.main:app --port 47242", "web", "running", 3.2 * H, ["http://127.0.0.1:47242", "http://localhost:47242/docs"], { path: "/atlas", upstream: "http://127.0.0.1:47242", stripPrefix: true, title: "Atlas", description: "Offline maps and saved places", icon: "🧭", color: "#7c9cff", order: 20, bypass: [], rootAliases: [] }, { venv: "C:\\projects\\atlas\\.venv", env: { PORT: "47242", LOG_LEVEL: "info" } }),
  svc("photos", "Photo Library", "C:\\projects\\photo-library", "node server.js", "web", "crashed", 0, [], { path: "/photos", upstream: "http://127.0.0.1:3070", stripPrefix: true, title: "Photos", description: "Family albums, backed up nightly", icon: "📷", color: "#ff7a90", order: 30 }),
  svc("home-dash", "Home Dashboard", "C:\\projects\\home-dashboard", "pnpm start", null, "running", 51 * 60e3, ["http://127.0.0.1:8123"], { path: "/home", upstream: "http://127.0.0.1:8123", stripPrefix: true, title: "Home", description: "Lights, sensors and energy", icon: "🏡", color: "#3ee6a2", order: 5 }),
  svc("api-gateway", "API Gateway", "C:\\projects\\gateway", "go run ./cmd/gateway", "infra", "running", 6 * 86400e3, ["http://127.0.0.1:9000"], null, { pathPrepend: ["C:\\tools\\go\\bin"] }),
  svc("docs", "Docs Wiki", "C:\\projects\\docs-wiki", "pnpm preview --port 4321", "infra", "stopped", 0, [], null),
  { ...svc("media", "Media Server", "", "", "infra", "running", 9 * 86400e3, [], { path: "/media", upstream: "http://127.0.0.1:8096", stripPrefix: false, title: "Media", description: "Movies and music", icon: "🎬", color: "#b69cff", order: 40 }), kind: "external", url: "http://127.0.0.1:8096", cwd: "", command: "" },
];

function svc(id, name, cwd, command, groupId, status, upMs, urls, publish, extra = {}) {
  const active = status === "running";
  return {
    id, name, cwd, command, args: [], env: extra.env, venv: extra.venv, pathPrepend: extra.pathPrepend, groupId, autoStart: true, restartOnCrash: id !== "photos", enabled: true, kind: "managed", publish,
    createdAt: ago(40 * 86400e3), updatedAt: ago(2 * 86400e3),
    runtime: { status, pid: active ? pidSeq++ : null, startedAt: active ? ago(upMs) : null, exitedAt: status === "crashed" ? ago(4 * 60e3) : null, exitCode: status === "crashed" ? 1 : null, urls, restarts: 0 },
  };
}

const portal = { enabled: true, port: 4790, title: "My Apps", publicUrl: "https://box.tail1234.ts.net", sessionDays: 400, tokenSet: true };
let sessions = [
  { id: "s1", deviceName: "Chrome on Android", userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36", ip: "100.88.12.4", createdAt: ago(21 * 86400e3), lastSeenAt: ago(60e3) },
  { id: "s2", deviceName: "Work laptop", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0", ip: "203.0.113.24", createdAt: ago(9 * 86400e3), lastSeenAt: ago(5 * H) },
  { id: "s3", deviceName: "Safari on iPad", userAgent: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", ip: "198.51.100.7", createdAt: ago(60 * 86400e3), lastSeenAt: ago(3 * 86400e3) },
];
const portalApps = () => services.filter((s) => s.publish).sort((a, b) => (a.publish.order ?? 100) - (b.publish.order ?? 100)).map((s) => ({
  id: s.id, name: s.publish.title || s.name, path: s.publish.path + "/", description: s.publish.description || "", icon: s.publish.icon || "", color: s.publish.color || "", status: s.runtime.status === "running" ? "up" : "down",
}));
const portalView = () => ({ ...portal, listening: portal.enabled, localUrl: `http://127.0.0.1:4798`, apps: portalApps(), sessions, tunnel: { provider: "tailscale", installed: true, running: true, dnsName: "box.tail1234.ts.net", funnelToPortal: true, publicUrl: "https://box.tail1234.ts.net", command: "tailscale funnel --bg 4790", installUrl: "https://tailscale.com/download/windows" } });

// ---- logs ----
const today = new Date().toISOString().slice(0, 10);
const dayBefore = (n) => new Date(now - n * 86400e3).toISOString().slice(0, 10);
const ROUTES = ["/api/items", "/api/items/42", "/api/search?q=coffee", "/health", "/api/tiles/12/2048/1361.png", "/assets/index-4f2a1c.js", "/api/sync"];
function genLine(id, t, i) {
  const r = (i * 7919 + id.length * 31) % 100;
  const ts = new Date(t).toISOString();
  if (r < 3) return `${ts} [stderr] Warning: deprecated option "legacyMode" will be removed in the next major version`;
  if (r < 5) return `${ts} [stderr] Error: ECONNRESET while fetching http://127.0.0.1:9000/api/v1/upstream — retrying in 2s`;
  if (r < 6) return `${ts} [sys] health check ok (${12 + (i % 30)} ms)`;
  const route = ROUTES[i % ROUTES.length];
  const code = r > 96 ? 500 : r > 90 ? 404 : r > 85 ? 304 : 200;
  return `${ts} [stdout] ${["GET", "GET", "POST", "GET"][i % 4]} ${route} ${code} ${3 + ((i * 13) % 180)}ms`;
}
function genLog(id, date, n) {
  const start = date === today ? now - 5 * H : Date.parse(date + "T08:00:00Z");
  const out = [
    `${new Date(start).toISOString()} [sys] starting: ${services.find((s) => s.id === id)?.command || "process"} (cwd ${services.find((s) => s.id === id)?.cwd || "-"})`,
    `${new Date(start + 10).toISOString()} [sys] pid 21408`,
    `${new Date(start + 900).toISOString()} [stdout]   VITE v5.4.2  ready in 412 ms`,
    `${new Date(start + 901).toISOString()} [stdout]   ➜  Local:   http://localhost:5173/`,
    `${new Date(start + 902).toISOString()} [stdout]   ➜  Network: use --host to expose`,
  ];
  const span = (date === today ? 5 * H : 10 * H) / n;
  for (let i = 0; i < n; i++) out.push(genLine(id, start + 2000 + i * span, i));
  if (id === "photos") out.push(`${new Date(now - 4 * 60e3).toISOString()} [stderr] Error: listen EADDRINUSE: address already in use 127.0.0.1:3070`, `${new Date(now - 4 * 60e3 + 5).toISOString()} [sys] exited with code 1`);
  return out.join("\n");
}

// ---- SSE ----
const clients = new Set();
const emit = (ev) => { for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`); };
let tick = 0;
setInterval(() => {
  const running = services.filter((s) => s.runtime.status === "running" && s.kind !== "external");
  if (!running.length) return;
  const s = running[tick % running.length];
  const line = genLine(s.id, Date.now(), tick++).replace(/^\S+ \[(\w+)\] /, "");
  const stream = /Warning|Error/.test(line) ? "stderr" : /health/.test(line) ? "sys" : "stdout";
  emit({ type: "log", serviceId: s.id, stream, line, ts: new Date().toISOString() });
}, 140);

function setStatus(s, status) {
  s.runtime.status = status;
  if (status === "running") { s.runtime.pid = pidSeq++; s.runtime.startedAt = new Date().toISOString(); }
  if (status === "stopped") { s.runtime.pid = null; s.runtime.startedAt = null; }
  emit({ type: "status", serviceId: s.id, status, pid: s.runtime.pid });
  emit({ type: "log", serviceId: s.id, stream: "sys", line: `status → ${status}`, ts: new Date().toISOString() });
}

// ---- helpers ----
const json = (res, code, body, extra = {}) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); });
function serveFile(res, base, rel, headers = {}) {
  const full = normalize(join(base, rel));
  if (!full.startsWith(normalize(base)) || !existsSync(full) || !statSync(full).isFile()) return json(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": MIME[extname(full)] || "application/octet-stream", "Cache-Control": "no-store", ...headers });
  res.end(readFileSync(full));
}
const view = () => ({ services, groups: groups.map((g) => ({ ...g, total: services.filter((s) => s.groupId === g.id).length, running: services.filter((s) => s.groupId === g.id && s.runtime.status === "running").length })) });

// ---- control panel ----
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const m = req.method;
  if (!p.startsWith("/api/")) {
    if (p === "/" ) { res.writeHead(302, { Location: "/dashboard.html" }); return res.end(); }
    if (p === "/dashboard.html") {
      const html = readFileSync(join(WEB, "dashboard.html"), "utf8").replace("%%BOOTSTRAP%%", JSON.stringify({ token: "demo-master-token-0000", port: 4780, version: "1.1.0", prompt: "", configDir: "%LOCALAPPDATA%\\ServiceRunner" }));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    return serveFile(res, WEB, p.slice(1));
  }
  if ((req.headers.authorization || "") !== "Bearer demo-master-token-0000") return json(res, 401, { error: "bad token" });
  if (p === "/api/v1/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`data: ${JSON.stringify({ type: "hello", ...view() })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (p === "/api/v1/services" && m === "GET") return json(res, 200, view());
  if (p === "/api/v1/stats") return json(res, 200, { running: services.filter((s) => s.runtime.status === "running").length, total: services.length, crashed: 1, stopped: 1, starting: 0, groups: 2, uptimeSec: Math.round((Date.now() - now) / 1000) + 9 * 86400 + 3600 * 3, port: 4780, cpuPct: 2 + Math.round(Math.random() * 5), memory: { runnerMb: 61.4, servicesMb: 1843.2, totalMb: 1904.6, runnerProcs: 2, serviceProcs: 17 } });
  if (p === "/api/v1/prompt") return json(res, 200, { text: "Service Runner is the local production host for long-running apps on this Windows machine (http://127.0.0.1:4780). Do not leave a terminal open — register the app so it survives reboots and can be restarted after you change code. Add or update with PUT http://127.0.0.1:4780/api/v1/services/<stable-id> JSON {\"name\":\"<app>\",\"cwd\":\"<absolute local path>\",\"command\":\"<how to run, e.g. pnpm dev>\",\"autoStart\":true} and header Authorization: Bearer demo-master-token-0000. Restart after changes: POST http://127.0.0.1:4780/api/v1/services/<id>/restart (same header). Local Windows paths only — no URLs, no network shares. Logs: %LOCALAPPDATA%\\ServiceRunner\\logs\\<id>\\ (last 14 days).", baseUrl: "http://127.0.0.1:4780", logRetentionDays: 14, endpoints: { upsert: "PUT http://127.0.0.1:4780/api/v1/services/:id", restart: "POST http://127.0.0.1:4780/api/v1/services/:id/restart", stop: "POST http://127.0.0.1:4780/api/v1/services/:id/stop", start: "POST http://127.0.0.1:4780/api/v1/services/:id/start", logs: "GET http://127.0.0.1:4780/api/v1/services/:id/logs", list: "GET http://127.0.0.1:4780/api/v1/services" } });
  if (p === "/api/v1/settings" && m === "GET") return json(res, 200, { port: 4780, logRetentionDays: 14, autoStartOnBoot: true, openDashboardOnLaunch: false, startupInstalled: true, token: "demo-master-token-0000" });
  if (p === "/api/v1/settings") { const b = await readBody(req); return json(res, 200, { ok: true, restartRequired: b.port !== undefined }); }
  if (p === "/api/v1/stop-all") { services.filter((s) => s.runtime.status === "running" && s.kind !== "external").forEach((s) => setStatus(s, "stopped")); return json(res, 200, { ok: true }); }
  if (p.startsWith("/api/v1/portal")) {
    if (NOPORTAL) return json(res, 404, { error: "no such endpoint" });
    if (p === "/api/v1/portal" && m === "GET") return json(res, 200, portalView());
    if (p === "/api/v1/portal" && m === "PATCH") { Object.assign(portal, await readBody(req)); emit({ type: "portal" }); return json(res, 200, portalView()); }
    if (p === "/api/v1/portal/token") { portal.tokenSet = true; sessions = []; emit({ type: "portal" }); return json(res, 200, { token: "pt_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + "Xy9_kQ" }); }
    if (p === "/api/v1/portal/sessions" && m === "DELETE") { const n = sessions.length; sessions = []; emit({ type: "portal" }); return json(res, 200, { ok: true, revoked: n }); }
    const sm = p.match(/^\/api\/v1\/portal\/sessions\/(.+)$/);
    if (sm && m === "DELETE") { sessions = sessions.filter((s) => s.id !== sm[1]); emit({ type: "portal" }); return json(res, 200, { ok: true }); }
  }
  if (p === "/api/v1/groups" && m === "POST") { const b = await readBody(req); const g = { id: b.id || b.name.toLowerCase().replace(/\W+/g, "-"), name: b.name }; groups.push(g); emit({ type: "config" }); return json(res, 201, g); }
  const gm = p.match(/^\/api\/v1\/groups\/([^/]+)(?:\/(start|stop))?$/);
  if (gm) {
    const g = groups.find((x) => x.id === gm[1]);
    if (!g) return json(res, 404, { error: "no group" });
    if (gm[2]) { services.filter((s) => s.groupId === g.id && s.kind !== "external").forEach((s) => setStatus(s, gm[2] === "start" ? "running" : "stopped")); return json(res, 200, { services: [] }); }
    if (m === "DELETE") { groups.splice(groups.indexOf(g), 1); services.forEach((s) => { if (s.groupId === g.id) s.groupId = null; }); emit({ type: "config" }); return json(res, 200, { ok: true }); }
    Object.assign(g, await readBody(req)); emit({ type: "config" }); return json(res, 200, g);
  }
  if (p === "/api/v1/services" && m === "POST") { const b = await readBody(req); const s = { ...svc(b.id || b.name.toLowerCase().replace(/\W+/g, "-"), b.name, b.cwd, b.command, b.groupId, "stopped", 0, [], b.publish), ...b }; services.push(s); emit({ type: "config" }); return json(res, 201, s); }
  const sm = p.match(/^\/api\/v1\/services\/([^/]+)(?:\/(start|stop|restart|logs))?$/);
  if (sm) {
    const id = decodeURIComponent(sm[1]);
    let s = services.find((x) => x.id === id);
    if (sm[2] === "logs") {
      const date = url.searchParams.get("date") || today;
      const tail = Number(url.searchParams.get("tail") || 400);
      const n = id === "docs" ? 0 : date === today ? (id === "notes" ? 4200 : 1500) : 600;
      const text = n ? genLog(id, date, n).split("\n").slice(-tail).join("\n") : "";
      return json(res, 200, { id, date, files: id === "docs" ? [] : [today, dayBefore(1), dayBefore(2), dayBefore(5)], text });
    }
    if (sm[2]) {
      if (s.kind === "external") return json(res, 400, { error: "external service is managed outside Service Runner" });
      if (sm[2] === "stop") { setStatus(s, "stopping"); setTimeout(() => setStatus(s, "stopped"), 700); }
      else { setStatus(s, "starting"); setTimeout(() => setStatus(s, "running"), 1100); }
      return json(res, 200, s);
    }
    if (m === "DELETE") { services.splice(services.indexOf(s), 1); emit({ type: "config" }); return json(res, 200, { ok: true }); }
    if (m === "PUT" || m === "PATCH") {
      const b = await readBody(req);
      if (!s) { s = svc(id, b.name, b.cwd, b.command, b.groupId, "stopped", 0, [], null); services.push(s); }
      Object.assign(s, b, { id });
      emit({ type: "config" });
      return json(res, 200, s);
    }
    return json(res, 200, s);
  }
  json(res, 404, { error: `no such endpoint ${m} ${p}` });
}).listen(4799, "127.0.0.1", () => console.log("control panel mock http://127.0.0.1:4799"));

// ---- portal ----
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const SEC = { "Content-Security-Policy": CSP, "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff" };
const live = new Map(); // sid -> deviceName
let fails = 0;
const sid = (req) => (/(?:^|;\s*)sr_portal=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/_portal/api/login" && req.method === "POST") {
    const b = await readBody(req);
    await new Promise((r) => setTimeout(r, 350));
    if (fails >= 5 && b.token !== "demo-access-token") return json(res, 429, { error: "too many attempts", retryAfterSec: 840 }, SEC);
    if (b.token !== "demo-access-token") { fails++; return json(res, 401, { error: "invalid token" }, SEC); }
    fails = 0; const id = "x" + Math.random().toString(36).slice(2);
    live.set(id, b.deviceName || "Unknown");
    return json(res, 200, { ok: true }, { ...SEC, "Set-Cookie": `sr_portal=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3456000` });
  }
  if (p === "/_portal/api/logout") { live.delete(sid(req)); return json(res, 200, { ok: true }, { ...SEC, "Set-Cookie": "sr_portal=; Path=/; Max-Age=0" }); }
  if (p.startsWith("/_portal/api/")) {
    const s = sid(req);
    if (!s || !live.has(s)) return json(res, 401, { error: "portal login required" }, SEC);
    if (p === "/_portal/api/me") return json(res, 200, { ok: true, session: { id: s, deviceName: live.get(s), createdAt: new Date().toISOString() } }, SEC);
    if (p === "/_portal/api/apps") return json(res, 200, { title: portal.title, apps: portalApps() }, SEC);
  }
  if (p === "/" || p === "/index.html") return serveFile(res, PWEB, "index.html", SEC);
  if (p.startsWith("/_portal/")) return serveFile(res, PWEB, p.slice("/_portal/".length), SEC);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<h1>Proxied app at ${p}</h1>`);
}).listen(4798, "127.0.0.1", () => console.log("portal mock http://127.0.0.1:4798"));
