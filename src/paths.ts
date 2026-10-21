import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = join(here, "..");
export const WEB_DIR = join(PROJECT_ROOT, "web");
export const PORTAL_WEB_DIR = join(PROJECT_ROOT, "portal-web");
export const ASSETS_DIR = join(PROJECT_ROOT, "assets");
export const TRAY_SCRIPT = join(PROJECT_ROOT, "scripts", "tray.ps1");
export const ICON_ICO = join(ASSETS_DIR, "icon.ico");
export const ICON_PNG = join(ASSETS_DIR, "icon.png");

/**
 * %LOCALAPPDATA%\ServiceRunner by default. SERVICE_RUNNER_DATA_DIR (absolute path) overrides it,
 * e.g. to run an isolated second instance for testing next to the real one.
 */
export function dataDir(): string {
  const override = process.env.SERVICE_RUNNER_DATA_DIR?.trim();
  const dir = override
    ? resolve(override)
    : join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ServiceRunner");
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

export function portalSessionsPath(): string {
  return join(dataDir(), "portal-sessions.json");
}

export function pidPath(): string {
  return join(dataDir(), "runner.pid");
}

/** Service Runner's own output when it runs hidden (the tray process has no console). */
export function runnerLogPath(): string {
  return join(dataDir(), "runner.log");
}

/** Present after a deliberate quit, so the watchdog leaves Service Runner stopped. */
export function quitMarkerPath(): string {
  return join(dataDir(), "quit-requested");
}

export function watchdogVbsPath(): string {
  return join(dataDir(), "watchdog.vbs");
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
