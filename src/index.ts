import { createServer as createNetServer } from "node:net";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadConfig, saveConfig } from "./config.ts";
import { dataDir, pidPath } from "./paths.ts";
import { pruneLogs } from "./logs.ts";
import { initProcessManager, startAutoServices, stopAllAndWait, getConfig } from "./process-manager.ts";
import { createAppServer } from "./server.ts";
import { startTray, stopTray } from "./tray.ts";
import { installStartup, uninstallStartup, writeLaunchVbs } from "./autostart.ts";
import { baseUrl } from "./prompt.ts";

const args = new Set(process.argv.slice(2));
const hidden = args.has("--hidden");
const setup = args.has("--setup");
const installOnly = args.has("--install-startup");
const uninstallOnly = args.has("--uninstall-startup");

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.error("Service Runner is Windows-only.");
    process.exit(1);
  }

  const cfg = loadConfig();
  initProcessManager(cfg);
  writeLaunchVbs();

  if (uninstallOnly) {
    uninstallStartup();
    cfg.autoStartOnBoot = false;
    saveConfig(cfg);
    console.log("Removed Service Runner from Windows Startup.");
    return;
  }

  if (installOnly || setup || cfg.autoStartOnBoot) {
    try {
      const lnk = await installStartup();
      cfg.autoStartOnBoot = true;
      saveConfig(cfg);
      console.log(`Startup shortcut: ${lnk}`);
    } catch (err) {
      console.warn("Could not install startup shortcut:", (err as Error).message);
    }
  }

  if (installOnly) return;

  const pruned = pruneLogs(cfg);
  if (pruned) console.log(`Pruned ${pruned} expired log file(s).`);

  const taken = await portTaken(cfg.port);
  if (taken) {
    console.log(`Service Runner already listening on ${baseUrl(cfg)}.`);
    if (!hidden) openBrowser(baseUrl(cfg) + "/");
    process.exit(0);
  }

  const server = createAppServer({
    onShutdown: shutdown,
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(cfg.port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  writeFileSync(pidPath(), String(process.pid), "utf8");
  console.log(`Service Runner ${baseUrl(cfg)}`);
  console.log(`Config  ${dataDir()}\\config.json`);
  console.log(`Logs    ${dataDir()}\\logs`);

  startTray(getConfig());
  startAutoServices();

  const openDash = !hidden && getConfig().openDashboardOnLaunch;
  if (openDash) openBrowser(baseUrl(getConfig()) + "/");

  const stop = () => {
    void shutdown();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Stopping all services…");
  try {
    await stopAllAndWait(8000);
  } catch {
    /* ignore */
  }
  stopTray();
  try {
    if (existsSync(pidPath())) unlinkSync(pidPath());
  } catch {
    /* ignore */
  }
  process.exit(0);
}

function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once("error", () => resolve(true));
    s.once("listening", () => {
      s.close(() => resolve(false));
    });
    s.listen(port, "127.0.0.1");
  });
}

function openBrowser(url: string): void {
  spawn("cmd", ["/c", "start", "", url], { windowsHide: true, stdio: "ignore", detached: true }).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
