import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { bus } from "../events.ts";
import { portalSessionsPath } from "../paths.ts";
import { getConfig } from "../process-manager.ts";
import { isLoopbackHost, originPort } from "../security.ts";
import { HttpError } from "../types.ts";
import { portalApps, routeApps } from "./apps.ts";
import {
  clearCookie,
  deviceLabel,
  LoginLimiter,
  readCookies,
  sessionCookie,
  SessionStore,
  verifyToken,
  type VerifyResult,
} from "./auth.ts";
import { errorResponse, json, notFound, serveAsset, serveHome, wantsHtml } from "./pages.ts";
import { clientAddr, proxyHttp, proxyUpgrade, rawResponse } from "./proxy.ts";
import { resolveRoute, sameOriginRefererPath, type RouteApp } from "./routing.ts";

let store: SessionStore | null = null;
const limiter = new LoginLimiter();

let server: Server | null = null;
let boundPort: number | null = null;
let lastError: string | null = null;
const sockets = new Set<Socket>();
let chain: Promise<void> = Promise.resolve();

export function portalSessions(): SessionStore {
  if (!store) {
    store = new SessionStore(portalSessionsPath(), () => getConfig().portal.sessionDays, () =>
      bus.emitEvent({ type: "portal" }),
    );
    store.startFlusher();
  }
  return store;
}

export function portalListening(): { listening: boolean; error: string | null } {
  return { listening: Boolean(server?.listening), error: lastError };
}

/** Start/stop/rebind to match config.portal. Serialized; safe to call any time. */
export function applyPortal(): Promise<void> {
  chain = chain.then(applyNow, applyNow);
  return chain;
}

export function stopPortal(): Promise<void> {
  chain = chain.then(closeNow, closeNow);
  return chain;
}

async function applyNow(): Promise<void> {
  const p = getConfig().portal;
  if (!p.enabled) {
    await closeNow();
    lastError = null;
    return;
  }
  if (server?.listening && boundPort === p.port) return;
  await closeNow();
  await listenNow(p.port);
}

function listenNow(port: number): Promise<void> {
  portalSessions();
  const s = createServer((req, res) => void handle(req, res));
  s.requestTimeout = 0; // long uploads / streams
  s.headersTimeout = 60_000;
  s.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head));
  s.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
  s.on("clientError", (_err, sock) => {
    if (sock.writable) sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return new Promise((resolve) => {
    s.once("error", (err: NodeJS.ErrnoException) => {
      lastError = err.code === "EADDRINUSE" ? `port ${port} is already in use` : err.message;
      console.warn(`Portal: could not listen on 127.0.0.1:${port}: ${lastError}`);
      server = null;
      boundPort = null;
      bus.emitEvent({ type: "portal" });
      resolve();
    });
    s.listen(port, "127.0.0.1", () => {
      server = s;
      boundPort = port;
      lastError = null;
      console.log(`Portal  http://127.0.0.1:${port}`);
      bus.emitEvent({ type: "portal" });
      resolve();
    });
  });
}

function closeNow(): Promise<void> {
  const s = server;
  if (!s) return Promise.resolve();
  server = null;
  boundPort = null;
  return new Promise((resolve) => {
    s.close(() => resolve());
    for (const sock of sockets) sock.destroy(); // SSE / WebSocket would otherwise hold close() open
    sockets.clear();
    bus.emitEvent({ type: "portal" });
  });
}

// ── request handling ────────────────────────────────────────────────────────

function parsePath(raw: string | undefined): { pathname: string; search: string } {
  const r = raw ?? "/";
  const u = r.startsWith("/") ? new URL("http://portal.invalid" + r) : new URL(r);
  return { pathname: u.pathname, search: u.search };
}

/**
 * Last X-Forwarded-For hop — the one the tunnel (our only direct peer) appended;
 * earlier hops are client-supplied and spoofable. Falls back to the socket address.
 */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const hops = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return (hops.at(-1) || clientAddr(req)).slice(0, 64);
}

function session(req: IncomingMessage): VerifyResult | null {
  const s = portalSessions();
  for (const v of readCookies(req.headers.cookie)) {
    const hit = s.verify(v);
    if (hit) return hit;
  }
  return null;
}

function refreshCookies(auth: VerifyResult | null): string[] {
  return auth?.refresh ? [sessionCookie(auth.refresh, getConfig().portal.sessionDays)] : [];
}

function unauthenticated(req: IncomingMessage, res: ServerResponse, pathAndQuery: string): void {
  if (req.method === "GET" && wantsHtml(req)) {
    res.writeHead(302, { Location: "/?next=" + encodeURIComponent(pathAndQuery), "Cache-Control": "no-store" });
    res.end();
    return;
  }
  json(res, 401, { error: "portal login required" });
}

function upstreamAllowed(app: RouteApp): boolean {
  const cfg = getConfig();
  try {
    const u = new URL(app.upstream);
    const port = originPort(app.upstream);
    return isLoopbackHost(u.hostname) && port !== cfg.port && port !== cfg.portal.port;
  } catch {
    return false;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    let pathname: string, search: string;
    try {
      ({ pathname, search } = parsePath(req.url));
    } catch {
      json(res, 400, { error: "bad request" });
      return;
    }
    const cfg = getConfig();
    const apps = routeApps(cfg);
    const route = resolveRoute(pathname, search, apps, sameOriginRefererPath(req.headers.referer, req.headers.host));

    switch (route.kind) {
      case "home":
        serveHome(req, res);
        return;
      case "portal":
        await handlePortal(req, res, pathname);
        return;
      case "notfound":
        notFound(req, res);
        return;
    }

    const auth = session(req);
    if (route.auth && !auth) {
      unauthenticated(req, res, pathname + search);
      return;
    }
    const extra = refreshCookies(auth);
    if (route.kind === "redirect") {
      res.writeHead(308, { Location: route.location, "Cache-Control": "no-store", ...(extra.length ? { "Set-Cookie": extra } : {}) });
      res.end();
      return;
    }
    const app = route.app;
    if (!upstreamAllowed(app)) {
      errorResponse(req, res, 502, `${app.name} is misconfigured`, "Its upstream is not an allowed local address.");
      return;
    }
    proxyHttp(req, res, app, route.upstreamPath, extra, () =>
      errorResponse(req, res, 502, `${app.name} is not running`, "The app did not answer. Try again in a moment."),
    );
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.message });
      return;
    }
    console.error("Portal:", err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
    else res.destroy();
  }
}

function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  socket.on("error", () => socket.destroy());
  let pathname: string, search: string;
  try {
    ({ pathname, search } = parsePath(req.url));
  } catch {
    rawResponse(socket, 400, "bad request");
    return;
  }
  const route = resolveRoute(pathname, search, routeApps(getConfig()), sameOriginRefererPath(req.headers.referer, req.headers.host));
  if (route.kind !== "proxy") {
    rawResponse(socket, 404, "not found");
    return;
  }
  if (route.auth) {
    if (!session(req)) {
      rawResponse(socket, 401, "portal login required");
      return;
    }
    // Cross-site WebSocket hijacking guard: a browser Origin must match the Host.
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host.toLowerCase() === String(req.headers.host ?? "").toLowerCase();
      } catch {
        /* ok stays false */
      }
      if (!ok) {
        rawResponse(socket, 403, "cross-origin websocket refused");
        return;
      }
    }
  }
  if (!upstreamAllowed(route.app)) {
    rawResponse(socket, 502, `${route.app.name} is misconfigured`);
    return;
  }
  proxyUpgrade(req, socket, head, route.app, route.upstreamPath);
}

// ── /_portal ───────────────────────────────────────────────────────────────

async function handlePortal(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const method = req.method ?? "GET";
  if (!pathname.startsWith("/_portal/api/")) {
    if (method !== "GET" && method !== "HEAD") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    serveAsset(req, res, pathname.slice("/_portal/".length));
    return;
  }
  const route = pathname.slice("/_portal/api".length);
  const cfg = getConfig();

  if (route === "/login") {
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const ip = clientIp(req);
    const wait = limiter.check(ip);
    if (wait !== null) {
      json(res, 429, { error: "too many login attempts — try again later", retryAfterSec: wait }, { "Retry-After": String(wait) });
      return;
    }
    const body = await readJson(req);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    // Count the attempt up front so parallel guesses can't race past the limit.
    const stamp = limiter.fail(ip);
    const ok = Boolean(cfg.portal.tokenHash) && token.length > 0 && (await verifyToken(token, cfg.portal.tokenHash));
    if (!ok) {
      json(res, 401, { error: cfg.portal.tokenHash ? "invalid access token" : "no access token has been set up yet" });
      return;
    }
    limiter.undo(ip, stamp);
    const ua = String(req.headers["user-agent"] ?? "");
    const rawName = typeof body.deviceName === "string" ? body.deviceName.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
    const { cookie } = portalSessions().create({
      deviceName: (rawName || deviceLabel(ua)).slice(0, 60),
      userAgent: ua,
      ip,
    });
    json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(cookie, cfg.portal.sessionDays) });
    return;
  }

  const auth = session(req);
  const cookies = refreshCookies(auth);
  const extra: Record<string, string | string[]> = cookies.length ? { "Set-Cookie": cookies } : {};

  if (route === "/logout") {
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!auth) return json(res, 401, { error: "portal login required" }, { "Set-Cookie": clearCookie() });
    portalSessions().revoke(auth.session.id);
    json(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
    return;
  }
  if (route === "/me") {
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (!auth) return json(res, 401, { error: "portal login required" });
    const s = auth.session;
    json(res, 200, { ok: true, session: { id: s.id, deviceName: s.deviceName, createdAt: s.createdAt } }, extra);
    return;
  }
  if (route === "/apps") {
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (!auth) return json(res, 401, { error: "portal login required" });
    json(res, 200, { title: cfg.portal.title, apps: await portalApps(cfg) }, extra);
    return;
  }
  json(res, 404, { error: "no such endpoint" });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8192) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "JSON object required");
}

/** Persist throttled session timestamps (call on shutdown). */
export function flushPortalSessions(): void {
  store?.flush();
}
