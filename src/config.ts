import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths.ts";
import { assertPublish } from "./portal/publish.ts";
import { assertLoopbackOrigin } from "./security.ts";
import type { AppConfig, GroupConfig, PortalConfig, ServiceConfig } from "./types.ts";

const VERSION = 1 as const;

export function defaultConfig(): AppConfig {
  return {
    version: VERSION,
    port: 4780,
    token: randomBytes(24).toString("hex"),
    logRetentionDays: 7,
    autoStartOnBoot: true,
    openDashboardOnLaunch: true,
    services: [],
    groups: [],
    portal: defaultPortal(),
  };
}

export function defaultPortal(): PortalConfig {
  return {
    enabled: false,
    port: 4790,
    title: "My Apps",
    publicUrl: "",
    sessionDays: 400,
    tokenHash: "",
  };
}

export function loadConfig(): AppConfig {
  const file = configPath();
  if (!existsSync(file)) {
    const fresh = defaultConfig();
    saveConfig(fresh);
    return fresh;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>;
    const cfg = migrate(raw);
    saveConfig(cfg);
    return cfg;
  } catch (err) {
    const bak = file + ".corrupt." + Date.now() + ".json";
    try {
      renameSync(file, bak);
    } catch {
      /* ignore */
    }
    const fresh = defaultConfig();
    saveConfig(fresh);
    console.warn(`Service Runner: config was unreadable, restored defaults. Old file: ${bak}`);
    console.warn(err);
    return fresh;
  }
}

export function saveConfig(cfg: AppConfig): void {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

function migrate(raw: Partial<AppConfig>): AppConfig {
  const base = defaultConfig();
  const port = Number(raw.port);
  const days = Number(raw.logRetentionDays);
  const cpPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : base.port;
  const portal = normalizePortal(raw.portal, cpPort);
  const reserved = [cpPort, portal.port];
  const services: ServiceConfig[] = [];
  for (const s of Array.isArray(raw.services) ? raw.services : []) {
    services.push(normalizeService(s, reserved, services));
  }
  return {
    version: VERSION,
    port: cpPort,
    token: typeof raw.token === "string" && raw.token.length >= 16 ? raw.token : base.token,
    logRetentionDays: Number.isInteger(days) && days >= 1 && days <= 365 ? days : 7,
    autoStartOnBoot: raw.autoStartOnBoot !== false,
    openDashboardOnLaunch: raw.openDashboardOnLaunch !== false,
    services,
    groups: Array.isArray(raw.groups) ? raw.groups.map(normalizeGroup) : [],
    portal,
  };
}

function normalizePortal(raw: Partial<PortalConfig> | undefined, cpPort: number): PortalConfig {
  const d = defaultPortal();
  const p = raw && typeof raw === "object" ? raw : {};
  const port = Number(p.port);
  const days = Number(p.sessionDays);
  return {
    enabled: p.enabled === true,
    port: Number.isInteger(port) && port > 0 && port < 65536 && port !== cpPort ? port : d.port === cpPort ? d.port + 1 : d.port,
    title: typeof p.title === "string" && p.title.trim() ? p.title.trim().slice(0, 80) : d.title,
    publicUrl: typeof p.publicUrl === "string" ? p.publicUrl.trim().replace(/\/+$/, "") : "",
    sessionDays: Number.isInteger(days) && days >= 1 && days <= 400 ? days : d.sessionDays,
    tokenHash: typeof p.tokenHash === "string" && p.tokenHash.startsWith("scrypt$") ? p.tokenHash : "",
  };
}

/** Lenient: an invalid publish/url from a hand-edited file is dropped with a warning, never fatal. */
function normalizeService(s: Partial<ServiceConfig>, reserved: number[], prev: ServiceConfig[]): ServiceConfig {
  const now = new Date().toISOString();
  const id = String(s.id ?? "");
  const kind = s.kind === "external" ? "external" : "managed";
  let url: string | undefined;
  if (kind === "external" && s.url) {
    try {
      url = assertLoopbackOrigin(s.url, "url", reserved, { allowPath: true });
    } catch (err) {
      console.warn(`Service Runner: dropped invalid url on '${id}': ${(err as Error).message}`);
    }
  }
  let publish: ServiceConfig["publish"] = null;
  if (s.publish) {
    try {
      publish = assertPublish(s.publish, { reservedPorts: reserved, others: prev });
    } catch (err) {
      console.warn(`Service Runner: dropped invalid publish on '${id}': ${(err as Error).message}`);
    }
  }
  return {
    id,
    name: String(s.name ?? s.id ?? "Untitled"),
    kind,
    url,
    publish,
    cwd: String(s.cwd ?? ""),
    command: String(s.command ?? ""),
    args: Array.isArray(s.args) ? s.args.map(String) : undefined,
    env: s.env && typeof s.env === "object" ? { ...s.env } : undefined,
    venv: s.venv ? String(s.venv) : undefined,
    pathPrepend: Array.isArray(s.pathPrepend) ? s.pathPrepend.map(String) : undefined,
    groupId: s.groupId ? String(s.groupId) : null,
    autoStart: s.autoStart !== false,
    restartOnCrash: Boolean(s.restartOnCrash),
    enabled: s.enabled !== false,
    createdAt: s.createdAt ?? now,
    updatedAt: s.updatedAt ?? now,
  };
}

function normalizeGroup(g: Partial<GroupConfig>): GroupConfig {
  return {
    id: String(g.id ?? ""),
    name: String(g.name ?? "Group"),
    color: g.color ? String(g.color) : undefined,
  };
}
