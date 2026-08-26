import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bus } from "./events.ts";
import { appendLog, LineBuffer } from "./logs.ts";
import { assertLocalDir, assertOptionalLocalDir, assertServiceId, slugify } from "./security.ts";
import { saveConfig } from "./config.ts";
import { bad, type AppConfig, type RuntimeState, type ServiceConfig, type ServiceStatus, type ServiceView } from "./types.ts";

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s"'<>]*)?/gi;
const HOSTPORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/gi;
const WIN_CMDS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "corepack"]);

interface Live {
  child: ChildProcess;
  stopping: boolean;
  crashRestarts: number;
  lastCrash: number;
}

const live = new Map<string, Live>();
const runtime = new Map<string, RuntimeState>();

let cfgRef: AppConfig;

export function initProcessManager(cfg: AppConfig): void {
  cfgRef = cfg;
  for (const s of cfg.services) runtime.set(s.id, emptyRuntime());
}

export function getConfig(): AppConfig {
  return cfgRef;
}

function persist(): void {
  saveConfig(cfgRef);
  bus.emitEvent({ type: "config" });
}

function emptyRuntime(): RuntimeState {
  return {
    status: "stopped",
    pid: null,
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    urls: [],
    restarts: 0,
  };
}

function rt(id: string): RuntimeState {
  let r = runtime.get(id);
  if (!r) {
    r = emptyRuntime();
    runtime.set(id, r);
  }
  return r;
}

function setStatus(id: string, status: ServiceStatus, extra: Partial<RuntimeState> = {}): void {
  const r = rt(id);
  Object.assign(r, extra, { status });
  bus.emitEvent({ type: "status", serviceId: id, status, pid: r.pid });
}

export function viewOf(s: ServiceConfig): ServiceView {
  return { ...s, runtime: { ...rt(s.id) } };
}

export function listServices(): ServiceView[] {
  return cfgRef.services.map(viewOf);
}

export function getService(id: string): ServiceView {
  const s = cfgRef.services.find((x) => x.id === id);
  if (!s) throw bad(404, `unknown service '${id}'`);
  return viewOf(s);
}

export function listGroups() {
  return cfgRef.groups.map((g) => {
    const members = cfgRef.services.filter((s) => s.groupId === g.id);
    const running = members.filter((s) => {
      const st = rt(s.id).status;
      return st === "running" || st === "starting";
    }).length;
    return { ...g, total: members.length, running };
  });
}

export interface UpsertBody {
  id?: string;
  name?: string;
  cwd?: string;
  command?: string;
  args?: string[] | string;
  env?: Record<string, string>;
  venv?: string;
  pathPrepend?: string[];
  groupId?: string | null;
  autoStart?: boolean;
  restartOnCrash?: boolean;
  enabled?: boolean;
  restart?: boolean;
}

export function upsertService(body: UpsertBody, { createOnly = false, idFromRoute }: { createOnly?: boolean; idFromRoute?: string } = {}): ServiceView {
  const name = String(body.name ?? "").trim() || "Untitled";
  let id = idFromRoute ?? body.id ?? slugify(name);
  id = assertServiceId(id);

  const existing = cfgRef.services.find((s) => s.id === id);
  if (existing && createOnly) throw bad(409, `service '${id}' already exists — use PUT to update it`);

  const cwd = assertLocalDir(body.cwd ?? existing?.cwd, "cwd");
  const command = String(body.command ?? existing?.command ?? "").trim();
  if (!command) throw bad(400, "command is required (e.g. \"pnpm dev\" or \"python -m uvicorn app:app\")");

  const args = normalizeArgs(body.args !== undefined ? body.args : existing?.args);
  const venv = assertOptionalLocalDir(body.venv ?? existing?.venv, "venv");
  const now = new Date().toISOString();

  const next: ServiceConfig = {
    id,
    name: body.name !== undefined ? name : existing?.name ?? name,
    cwd,
    command,
    args,
    env: body.env !== undefined ? sanitizeEnv(body.env) : existing?.env,
    venv,
    pathPrepend: body.pathPrepend !== undefined ? body.pathPrepend.map(String) : existing?.pathPrepend,
    groupId:
      body.groupId !== undefined
        ? body.groupId
          ? existingGroup(body.groupId)
          : null
        : existing?.groupId ?? null,
    autoStart: body.autoStart !== undefined ? Boolean(body.autoStart) : existing?.autoStart ?? true,
    restartOnCrash:
      body.restartOnCrash !== undefined ? Boolean(body.restartOnCrash) : existing?.restartOnCrash ?? false,
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existing) {
    const idx = cfgRef.services.findIndex((s) => s.id === id);
    cfgRef.services[idx] = next;
  } else {
    cfgRef.services.push(next);
    runtime.set(id, emptyRuntime());
  }
  persist();

  const changed =
    existing &&
    (existing.cwd !== next.cwd ||
      existing.command !== next.command ||
      JSON.stringify(existing.args ?? []) !== JSON.stringify(next.args ?? []) ||
      JSON.stringify(existing.env ?? {}) !== JSON.stringify(next.env ?? {}) ||
      existing.venv !== next.venv);

  const shouldRestart = body.restart === true || (Boolean(existing) && changed && isActive(id));
  if (shouldRestart) {
    void restartService(id);
  }
  return viewOf(next);
}

export function deleteService(id: string): void {
  const s = cfgRef.services.find((x) => x.id === id);
  if (!s) throw bad(404, `unknown service '${id}'`);
  if (isActive(id)) stopService(id, { wait: false });
  cfgRef.services = cfgRef.services.filter((x) => x.id !== id);
  runtime.delete(id);
  live.delete(id);
  persist();
}

export function upsertGroup(body: { id?: string; name?: string; color?: string }, idFromRoute?: string) {
  const name = String(body.name ?? "").trim();
  if (!name) throw bad(400, "group name is required");
  const id = assertServiceId(idFromRoute ?? body.id ?? slugify(name));
  const existing = cfgRef.groups.find((g) => g.id === id);
  const next = { id, name, color: body.color ?? existing?.color };
  if (existing) {
    Object.assign(existing, next);
  } else {
    cfgRef.groups.push(next);
  }
  persist();
  return next;
}

export function deleteGroup(id: string): void {
  if (!cfgRef.groups.some((g) => g.id === id)) throw bad(404, `unknown group '${id}'`);
  cfgRef.groups = cfgRef.groups.filter((g) => g.id !== id);
  for (const s of cfgRef.services) {
    if (s.groupId === id) s.groupId = null;
  }
  persist();
}

function existingGroup(id: string): string {
  assertServiceId(id);
  if (!cfgRef.groups.some((g) => g.id === id)) throw bad(400, `unknown group '${id}'`);
  return id;
}

function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k || /[\r\n=]/.test(k)) continue;
    out[k] = String(v);
  }
  return out;
}

function normalizeArgs(args: string[] | string | undefined): string[] | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "string") {
    const t = args.trim();
    return t ? splitArgs(t) : undefined;
  }
  if (!Array.isArray(args)) throw bad(400, "args must be a string or array of strings");
  return args.map(String);
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function isActive(id: string): boolean {
  const st = rt(id).status;
  return st === "running" || st === "starting" || st === "stopping";
}

export function startService(id: string): ServiceView {
  const s = cfgRef.services.find((x) => x.id === id);
  if (!s) throw bad(404, `unknown service '${id}'`);
  if (!s.enabled) throw bad(400, `service '${id}' is disabled`);
  if (isActive(id) && live.get(id)?.child && !live.get(id)?.child.killed) {
    return viewOf(s);
  }
  launch(s);
  return viewOf(s);
}

export function stopService(id: string, { wait = true }: { wait?: boolean } = {}): ServiceView {
  const s = cfgRef.services.find((x) => x.id === id);
  if (!s) throw bad(404, `unknown service '${id}'`);
  const l = live.get(id);
  if (!l) {
    setStatus(id, "stopped", { pid: null });
    return viewOf(s);
  }
  l.stopping = true;
  setStatus(id, "stopping");
  appendLog(id, "sys", "stop requested");
  killTree(l.child.pid);
  if (wait) {
    // best-effort; caller doesn't block the HTTP thread long
  }
  return viewOf(s);
}

export async function restartService(id: string): Promise<ServiceView> {
  const s = cfgRef.services.find((x) => x.id === id);
  if (!s) throw bad(404, `unknown service '${id}'`);
  if (isActive(id)) {
    const l = live.get(id);
    if (l) {
      l.stopping = true;
      setStatus(id, "stopping");
      appendLog(id, "sys", "restart requested");
      await killTreeAndWait(l.child.pid, 8000);
    }
  }
  launch(s);
  return viewOf(s);
}

export async function startGroup(groupId: string): Promise<ServiceView[]> {
  if (!cfgRef.groups.some((g) => g.id === groupId)) throw bad(404, `unknown group '${groupId}'`);
  const out: ServiceView[] = [];
  for (const s of cfgRef.services.filter((x) => x.groupId === groupId && x.enabled)) {
    try {
      out.push(startService(s.id));
    } catch (err) {
      appendLog(s.id, "sys", `group start failed: ${(err as Error).message}`);
    }
  }
  return out;
}

export async function stopGroup(groupId: string): Promise<ServiceView[]> {
  if (!cfgRef.groups.some((g) => g.id === groupId)) throw bad(404, `unknown group '${groupId}'`);
  const out: ServiceView[] = [];
  for (const s of cfgRef.services.filter((x) => x.groupId === groupId)) {
    out.push(stopService(s.id, { wait: false }));
  }
  return out;
}

export function stopAll({ wait = false }: { wait?: boolean } = {}): void {
  for (const s of cfgRef.services) {
    if (isActive(s.id)) stopService(s.id, { wait });
  }
}

export async function stopAllAndWait(timeoutMs = 8000): Promise<void> {
  const pids: number[] = [];
  for (const [id, l] of live) {
    l.stopping = true;
    setStatus(id, "stopping");
    if (l.child.pid) pids.push(l.child.pid);
  }
  await Promise.all(pids.map((pid) => killTreeAndWait(pid, timeoutMs)));
}

export function startAutoServices(): void {
  for (const s of cfgRef.services) {
    if (s.enabled && s.autoStart) {
      try {
        startService(s.id);
      } catch (err) {
        appendLog(s.id, "sys", `auto-start failed: ${(err as Error).message}`);
      }
    }
  }
}

function launch(s: ServiceConfig): void {
  assertLocalDir(s.cwd, "cwd");
  const env: NodeJS.ProcessEnv = { ...process.env, ...(s.env ?? {}) };
  env.FORCE_COLOR = env.FORCE_COLOR ?? "0";
  if (s.venv) {
    const scripts = join(s.venv, "Scripts");
    const bin = existsSync(scripts) ? scripts : join(s.venv, "bin");
    env.VIRTUAL_ENV = s.venv;
    env.PATH = bin + ";" + (env.PATH ?? "");
  }
  if (s.pathPrepend?.length) {
    env.PATH = s.pathPrepend.join(";") + ";" + (env.PATH ?? "");
  }

  const { file, args, shell } = commandParts(s);
  const child = spawn(file, args, {
    cwd: s.cwd,
    env,
    windowsHide: true,
    shell,
    stdio: ["ignore", "pipe", "pipe"],
  });

  live.set(s.id, { child, stopping: false, crashRestarts: live.get(s.id)?.crashRestarts ?? 0, lastCrash: 0 });
  const r = rt(s.id);
  r.urls = [];
  r.exitCode = null;
  r.exitedAt = null;
  r.startedAt = new Date().toISOString();
  r.pid = child.pid ?? null;
  setStatus(s.id, "starting", { pid: r.pid, startedAt: r.startedAt, urls: [] });
  appendLog(s.id, "sys", `started pid=${child.pid ?? "?"} cmd=${formatCmd(s)} cwd=${s.cwd}`);

  const outBuf = new LineBuffer((line) => {
    appendLog(s.id, "stdout", line);
    absorbUrls(s.id, line);
  });
  const errBuf = new LineBuffer((line) => {
    appendLog(s.id, "stderr", line);
    absorbUrls(s.id, line);
  });
  child.stdout?.on("data", (c) => outBuf.push(c));
  child.stderr?.on("data", (c) => errBuf.push(c));

  // If it stays alive briefly, treat it as running even before a URL appears.
  const readyTimer = setTimeout(() => {
    if (live.get(s.id)?.child === child && rt(s.id).status === "starting") {
      setStatus(s.id, "running");
    }
  }, 2500);

  child.on("error", (err) => {
    appendLog(s.id, "sys", `spawn error: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    clearTimeout(readyTimer);
    outBuf.flush();
    errBuf.flush();
    const l = live.get(s.id);
    const expected = l?.stopping || l?.child !== child;
    if (l?.child === child) live.delete(s.id);
    rt(s.id).pid = null;
    rt(s.id).exitCode = code;
    rt(s.id).exitedAt = new Date().toISOString();
    appendLog(s.id, "sys", `exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    if (expected) {
      setStatus(s.id, "stopped", { pid: null });
      return;
    }
    setStatus(s.id, "crashed", { pid: null });
    if (s.restartOnCrash) scheduleCrashRestart(s);
  });
}

function scheduleCrashRestart(s: ServiceConfig): void {
  const now = Date.now();
  const l = live.get(s.id);
  const recent = l && now - l.lastCrash < 60_000 ? l.crashRestarts : 0;
  const next = recent + 1;
  if (next > 5) {
    appendLog(s.id, "sys", "gave up restarting after 5 crashes in 60s");
    return;
  }
  const delay = Math.min(8000, 500 * 2 ** (next - 1));
  appendLog(s.id, "sys", `crash restart ${next}/5 in ${delay}ms`);
  setTimeout(() => {
    const current = cfgRef.services.find((x) => x.id === s.id);
    if (!current || !current.enabled || !current.restartOnCrash) return;
    if (isActive(s.id)) return;
    const r = rt(s.id);
    r.restarts += 1;
    try {
      launch(current);
      const liveNow = live.get(s.id);
      if (liveNow) {
        liveNow.crashRestarts = next;
        liveNow.lastCrash = now;
      }
    } catch (err) {
      appendLog(s.id, "sys", `crash restart failed: ${(err as Error).message}`);
    }
  }, delay);
}

function commandParts(s: ServiceConfig): { file: string; args: string[]; shell: boolean } {
  const extra = s.args ?? [];
  const first = s.command.trim();
  const tokens = first.includes(" ") && extra.length === 0 ? splitArgs(first) : [first, ...extra];
  const exe = tokens[0] ?? first;
  const rest = tokens.slice(1);
  const base = exe.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const needsShell =
    process.platform === "win32" &&
    (WIN_CMDS.has(base) ||
      base.endsWith(".cmd") ||
      base.endsWith(".bat") ||
      first.includes(" ") && extra.length === 0);
  if (needsShell) {
    // One command line so .cmd shims (pnpm, npm) resolve via PATH.
    const line = extra.length ? [first, ...extra.map(quoteCmd)].join(" ") : first;
    return { file: line, args: [], shell: true };
  }
  return { file: exe, args: rest, shell: false };
}

function quoteCmd(a: string): string {
  if (!/[ \t"&<>|^]/.test(a)) return a;
  return `"${a.replace(/"/g, '\\"')}"`;
}

function formatCmd(s: ServiceConfig): string {
  return s.args?.length ? `${s.command} ${s.args.join(" ")}` : s.command;
}

function absorbUrls(id: string, line: string): void {
  const found = new Set<string>();
  for (const m of line.matchAll(URL_RE)) {
    found.add(normalizeUrl(m[0]));
  }
  for (const m of line.matchAll(HOSTPORT_RE)) {
    found.add(`http://127.0.0.1:${m[1]}`);
  }
  if (!found.size) return;
  const r = rt(id);
  let changed = false;
  for (const u of found) {
    if (!r.urls.includes(u) && r.urls.length < 8) {
      r.urls.push(u);
      changed = true;
    }
  }
  if (changed) {
    if (r.status === "starting") setStatus(id, "running");
    bus.emitEvent({ type: "urls", serviceId: id, urls: [...r.urls] });
  }
}

function normalizeUrl(u: string): string {
  const cleaned = u.replace(/[),.;]+$/, "");
  try {
    const url = new URL(cleaned);
    if (url.hostname === "0.0.0.0" || url.hostname === "localhost" || url.hostname === "[::1]") {
      url.hostname = "127.0.0.1";
    }
    if (url.pathname === "/" && !url.search && !url.hash) {
      return url.origin;
    }
    return url.toString();
  } catch {
    return cleaned
      .replace("://0.0.0.0", "://127.0.0.1")
      .replace("://[::1]", "://127.0.0.1")
      .replace("://localhost", "://127.0.0.1")
      .replace(/\/$/, "");
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

function killTreeAndWait(pid: number | undefined, timeoutMs: number): Promise<void> {
  if (!pid) return Promise.resolve();
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const t = setTimeout(() => resolve(), timeoutMs);
    child.on("exit", () => {
      clearTimeout(t);
      setTimeout(() => resolve(), 250);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
