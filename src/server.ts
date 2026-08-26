import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { WEB_DIR } from "./paths.ts";
import { bus } from "./events.ts";
import { saveConfig } from "./config.ts";
import { listLogDates, readLogTail } from "./logs.ts";
import { agentPrompt, baseUrl, promptPayload } from "./prompt.ts";
import { installStartup, startupInstalled, uninstallStartup } from "./autostart.ts";
import {
  deleteGroup,
  deleteService,
  getConfig,
  getService,
  listGroups,
  listServices,
  restartService,
  startGroup,
  startService,
  stopAll,
  stopGroup,
  stopService,
  upsertGroup,
  upsertService,
  type UpsertBody,
} from "./process-manager.ts";
import { HttpError, type AppConfig, type TrayPayload } from "./types.ts";
import { isLoopbackAddr } from "./security.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const VERSION = "1.0.0";

export interface ServerHooks {
  onShutdown: () => Promise<void>;
}

export function createAppServer(hooks: ServerHooks): Server {
  return createServer((req, res) => {
    void handle(req, res, hooks);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, hooks: ServerHooks): Promise<void> {
  try {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!guardLocal(req, res)) return;

    if (req.method === "OPTIONS") {
      cors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    const path = url.pathname;
    if (path === "/api/v1/health") {
      json(res, 200, { ok: true, version: VERSION, port: getConfig().port });
      return;
    }

    if (path.startsWith("/api/")) {
      if (!auth(req, res)) return;
      await routeApi(req, res, url, hooks);
      return;
    }

    serveStatic(req, res, path);
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.message });
      return;
    }
    console.error(err);
    json(res, 500, { error: (err as Error).message || "internal error" });
  }
}

function guardLocal(req: IncomingMessage, res: ServerResponse): boolean {
  const ra = req.socket.remoteAddress ?? "";
  if (!isLoopbackAddr(ra) && ra !== "::ffff:127.0.0.1") {
    json(res, 403, { error: "Service Runner only accepts local connections" });
    return false;
  }
  cors(req, res);
  return true;
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
}

function auth(req: IncomingMessage, res: ServerResponse): boolean {
  const cfg = getConfig();
  const header = req.headers.authorization ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const alt = typeof req.headers["x-service-runner-token"] === "string" ? req.headers["x-service-runner-token"] : "";
  if (token === cfg.token || alt === cfg.token) return true;
  json(res, 401, { error: "missing or invalid token. Copy the prompt from the control panel." });
  return false;
}

async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL, hooks: ServerHooks): Promise<void> {
  const method = req.method ?? "GET";
  const p = url.pathname;
  const cfg = getConfig();

  if (method === "GET" && p === "/api/v1/info") {
    json(res, 200, {
      version: VERSION,
      baseUrl: baseUrl(cfg),
      port: cfg.port,
      logRetentionDays: cfg.logRetentionDays,
      autoStartOnBoot: cfg.autoStartOnBoot,
      startupInstalled: startupInstalled(),
      logDir: "%LOCALAPPDATA%\\ServiceRunner\\logs",
      configDir: "%LOCALAPPDATA%\\ServiceRunner",
      uptimeSec: Math.round(process.uptime()),
    });
    return;
  }

  if (method === "GET" && p === "/api/v1/prompt") {
    json(res, 200, promptPayload(cfg));
    return;
  }

  if (method === "GET" && p === "/api/v1/settings") {
    json(res, 200, {
      port: cfg.port,
      logRetentionDays: cfg.logRetentionDays,
      autoStartOnBoot: cfg.autoStartOnBoot,
      openDashboardOnLaunch: cfg.openDashboardOnLaunch,
      startupInstalled: startupInstalled(),
      token: cfg.token,
    });
    return;
  }

  if ((method === "PATCH" || method === "PUT") && p === "/api/v1/settings") {
    const body = await readJson(req);
    if (body.logRetentionDays !== undefined) {
      const n = Number(body.logRetentionDays);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, "logRetentionDays must be 1–365");
      cfg.logRetentionDays = n;
    }
    if (body.openDashboardOnLaunch !== undefined) cfg.openDashboardOnLaunch = Boolean(body.openDashboardOnLaunch);
    if (body.port !== undefined) {
      const n = Number(body.port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new HttpError(400, "port must be 1–65535");
      cfg.port = n;
    }
    if (body.autoStartOnBoot !== undefined) {
      cfg.autoStartOnBoot = Boolean(body.autoStartOnBoot);
      if (cfg.autoStartOnBoot) await installStartup();
      else uninstallStartup();
    }
    if (body.regenerateToken === true) {
      const { randomBytes } = await import("node:crypto");
      cfg.token = randomBytes(24).toString("hex");
    }
    saveConfig(cfg);
    json(res, 200, { ok: true, settings: { ...cfg, services: undefined, groups: undefined }, restartRequired: body.port !== undefined });
    return;
  }

  if (method === "GET" && p === "/api/v1/tray") {
    json(res, 200, trayPayload(cfg));
    return;
  }

  if (method === "GET" && p === "/api/v1/events") {
    sse(req, res);
    return;
  }

  if (method === "GET" && p === "/api/v1/services") {
    json(res, 200, { services: listServices(), groups: listGroups() });
    return;
  }

  if (method === "POST" && p === "/api/v1/services") {
    const body = await readJson(req);
    json(res, 201, upsertService(body as UpsertBody, { createOnly: true }));
    return;
  }

  const svc = p.match(/^\/api\/v1\/services\/([^/]+)(?:\/(start|stop|restart|logs))?$/);
  if (svc) {
    const id = decodeURIComponent(svc[1]);
    const action = svc[2];
    if (method === "GET" && !action) {
      json(res, 200, getService(id));
      return;
    }
    if (method === "GET" && action === "logs") {
      const date = url.searchParams.get("date") ?? undefined;
      const tail = Number(url.searchParams.get("tail") ?? 400);
      json(res, 200, {
        id,
        date: date ?? null,
        files: listLogDates(id),
        text: readLogTail(id, date, Number.isFinite(tail) ? tail : 400),
      });
      return;
    }
    if (method === "PUT" || method === "PATCH") {
      const body = await readJson(req);
      const created = !getConfig().services.some((s) => s.id === id);
      json(res, created ? 201 : 200, upsertService(body as UpsertBody, { idFromRoute: id }));
      return;
    }
    if (method === "DELETE" && !action) {
      deleteService(id);
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && action === "start") {
      json(res, 200, startService(id));
      return;
    }
    if (method === "POST" && action === "stop") {
      json(res, 200, stopService(id, { wait: false }));
      return;
    }
    if (method === "POST" && action === "restart") {
      json(res, 200, await restartService(id));
      return;
    }
  }

  if (method === "GET" && p === "/api/v1/groups") {
    json(res, 200, { groups: listGroups() });
    return;
  }
  if (method === "POST" && p === "/api/v1/groups") {
    const body = await readJson(req);
    json(res, 201, upsertGroup(body as { id?: string; name?: string; color?: string }));
    return;
  }
  const grp = p.match(/^\/api\/v1\/groups\/([^/]+)(?:\/(start|stop))?$/);
  if (grp) {
    const id = decodeURIComponent(grp[1]);
    const action = grp[2];
    if ((method === "PUT" || method === "PATCH") && !action) {
      const body = await readJson(req);
      json(res, 200, upsertGroup(body as { id?: string; name?: string; color?: string }, id));
      return;
    }
    if (method === "DELETE" && !action) {
      deleteGroup(id);
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && action === "start") {
      json(res, 200, { services: await startGroup(id) });
      return;
    }
    if (method === "POST" && action === "stop") {
      json(res, 200, { services: await stopGroup(id) });
      return;
    }
  }

  if (method === "POST" && p === "/api/v1/stop-all") {
    stopAll({ wait: false });
    json(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && p === "/api/v1/shutdown") {
    json(res, 200, { ok: true, shuttingDown: true });
    setTimeout(() => {
      void hooks.onShutdown();
    }, 150);
    return;
  }

  json(res, 404, { error: `no such endpoint ${method} ${p}` });
}

function trayPayload(cfg: AppConfig): TrayPayload {
  const groups = listGroups();
  return {
    baseUrl: baseUrl(cfg),
    groups: groups.map((g) => ({ id: g.id, name: g.name, running: g.running, total: g.total })),
    services: listServices().map((s) => ({
      id: s.id,
      name: s.name,
      status: s.runtime.status,
      groupId: s.groupId ?? null,
      groupName: groups.find((g) => g.id === s.groupId)?.name ?? null,
    })),
  };
}

function sse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");
  const send = (ev: unknown) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  send({ type: "hello", services: listServices(), groups: listGroups() });
  const off = bus.onEvent(send);
  const ping = setInterval(() => res.write(":\n\n"), 15000);
  req.on("close", () => {
    off();
    clearInterval(ping);
  });
}

function serveStatic(_req: IncomingMessage, res: ServerResponse, path: string): void {
  if (path === "/" || path === "/index.html") {
    const htmlPath = join(WEB_DIR, "index.html");
    let html = readFileSync(htmlPath, "utf8");
    const cfg = getConfig();
    const bootstrap = {
      token: cfg.token,
      port: cfg.port,
      version: VERSION,
      prompt: agentPrompt(cfg),
      logDir: "%LOCALAPPDATA%\\ServiceRunner\\logs",
      configDir: "%LOCALAPPDATA%\\ServiceRunner",
      logRetentionDays: cfg.logRetentionDays,
    };
    html = html.replace("%%BOOTSTRAP%%", JSON.stringify(bootstrap));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
    return;
  }

  const rel = path.replace(/^\/+/, "").replace(/\//g, sep);
  const full = normalize(join(WEB_DIR, rel));
  if (!full.startsWith(normalize(WEB_DIR) + sep) && full !== normalize(WEB_DIR)) {
    json(res, 403, { error: "forbidden" });
    return;
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    json(res, 404, { error: "not found" });
    return;
  }
  const type = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=3600" });
  res.end(readFileSync(full));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    throw new HttpError(400, "JSON object required");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "invalid JSON");
  }
}
