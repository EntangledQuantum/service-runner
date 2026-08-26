import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths.ts";
import type { AppConfig, GroupConfig, ServiceConfig } from "./types.ts";

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
  return {
    version: VERSION,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : base.port,
    token: typeof raw.token === "string" && raw.token.length >= 16 ? raw.token : base.token,
    logRetentionDays: Number.isInteger(days) && days >= 1 && days <= 365 ? days : 7,
    autoStartOnBoot: raw.autoStartOnBoot !== false,
    openDashboardOnLaunch: raw.openDashboardOnLaunch !== false,
    services: Array.isArray(raw.services) ? raw.services.map(normalizeService) : [],
    groups: Array.isArray(raw.groups) ? raw.groups.map(normalizeGroup) : [],
  };
}

function normalizeService(s: Partial<ServiceConfig>): ServiceConfig {
  const now = new Date().toISOString();
  return {
    id: String(s.id ?? ""),
    name: String(s.name ?? s.id ?? "Untitled"),
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
