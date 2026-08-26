import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { ICON_ICO, ICON_PNG, TRAY_SCRIPT } from "./paths.ts";
import { baseUrl } from "./prompt.ts";
import type { AppConfig } from "./types.ts";

let child: ChildProcess | null = null;

export function startTray(cfg: AppConfig): ChildProcess | null {
  if (process.platform !== "win32") {
    console.warn("Service Runner tray is Windows-only.");
    return null;
  }
  if (!existsSync(TRAY_SCRIPT)) {
    console.warn("tray.ps1 missing — control panel still runs.");
    return null;
  }
  const icon = existsSync(ICON_ICO) ? ICON_ICO : ICON_PNG;
  child = spawn(
    "powershell.exe",
    [
      "-STA",
      "-NoProfile",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      TRAY_SCRIPT,
      "-BaseUrl",
      baseUrl(cfg),
      "-Token",
      cfg.token,
      "-IconPath",
      icon,
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr?.on("data", (c) => {
    const msg = c.toString().trim();
    if (msg) console.warn("tray:", msg);
  });
  child.on("exit", (code) => {
    if (code && code !== 0) console.warn(`tray exited with code ${code}`);
    child = null;
  });
  return child;
}

export function stopTray(): void {
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  child = null;
}
