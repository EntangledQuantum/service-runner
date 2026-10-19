import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** What the Portal tab needs to know about Tailscale on this machine. Never throws. */
export interface TunnelState {
  provider: "tailscale";
  installed: boolean;
  /** Logged in and connected to a tailnet. */
  running: boolean;
  /** MagicDNS name without the trailing dot, e.g. "box.tailnet.ts.net". */
  dnsName: string;
  /** Funnel serves the portal port on :443 → https://<dnsName>. */
  funnelToPortal: boolean;
  publicUrl: string;
  /** Command that exposes the portal through Funnel. */
  command: string;
  installUrl: string;
}

const INSTALL_URL = "https://tailscale.com/download/windows";
const TTL_MS = 15_000;
let cache: { at: number; port: number; value: Promise<TunnelState> } | null = null;

export function tunnelState(portalPort: number): Promise<TunnelState> {
  if (cache && cache.port === portalPort && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = detect(portalPort);
  cache = { at: Date.now(), port: portalPort, value };
  return value;
}

async function detect(port: number): Promise<TunnelState> {
  const base: TunnelState = {
    provider: "tailscale",
    installed: false,
    running: false,
    dnsName: "",
    funnelToPortal: false,
    publicUrl: "",
    command: `tailscale funnel --bg ${port}`,
    installUrl: INSTALL_URL,
  };
  const bin = findBinary();
  if (!bin) return base;
  base.installed = true;

  const status = parse(await run(bin, ["status", "--json"]));
  base.running = status?.BackendState === "Running";
  base.dnsName = String(status?.Self?.DNSName ?? "").replace(/\.$/, "");
  if (!base.running || !base.dnsName) return base;

  const serve = parse(await run(bin, ["serve", "status", "--json"]));
  const hostPort = `${base.dnsName}:443`;
  const handlers = serve?.Web?.[hostPort]?.Handlers ?? {};
  const proxy = String(handlers["/"]?.Proxy ?? "");
  const toPortal = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost|\\[::1\\])?:?${port}/?$`).test(proxy);
  base.funnelToPortal = toPortal && serve?.AllowFunnel?.[hostPort] === true;
  if (base.funnelToPortal) base.publicUrl = `https://${base.dnsName}`;
  return base;
}

function findBinary(): string | null {
  const dirs = (process.env.PATH ?? "").split(";").filter(Boolean);
  for (const d of dirs) {
    const p = join(d, "tailscale.exe");
    if (existsSync(p)) return p;
  }
  const pf = join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe");
  return existsSync(pf) ? pf : null;
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 4000, windowsHide: true }, (_err, stdout) => resolve(String(stdout ?? "")));
  });
}

function parse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
