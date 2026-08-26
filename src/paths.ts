import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = join(here, "..");
export const WEB_DIR = join(PROJECT_ROOT, "web");
export const ASSETS_DIR = join(PROJECT_ROOT, "assets");
export const TRAY_SCRIPT = join(PROJECT_ROOT, "scripts", "tray.ps1");
export const ICON_ICO = join(ASSETS_DIR, "icon.ico");
export const ICON_PNG = join(ASSETS_DIR, "icon.png");

export function dataDir(): string {
  const base =
    process.env.LOCALAPPDATA ||
    join(homedir(), "AppData", "Local");
  const dir = join(base, "ServiceRunner");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(): string {
  return join(dataDir(), "config.json");
}

export function logsDir(): string {
  const dir = join(dataDir(), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function serviceLogsDir(id: string): string {
  const dir = join(logsDir(), sanitizeIdForPath(id));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function launchVbsPath(): string {
  return join(dataDir(), "launch.vbs");
}

export function pidPath(): string {
  return join(dataDir(), "runner.pid");
}

export function sanitizeIdForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Human-readable path for agent prompts, with the env var unexpanded. */
export function logsDirPrompt(): string {
  return "%LOCALAPPDATA%\\ServiceRunner\\logs";
}

export function configDirPrompt(): string {
  return "%LOCALAPPDATA%\\ServiceRunner";
}
