export type ServiceStatus = "stopped" | "starting" | "running" | "stopping" | "crashed";

export interface ServiceEnv {
  [key: string]: string;
}

export type ServiceKind = "managed" | "external";

export interface PublishConfig {
  /** Public path prefix, one lowercase segment: "/atlas". */
  path: string;
  /** Loopback origin, e.g. "http://127.0.0.1:47242". */
  upstream: string;
  /** true: "/atlas/x" → upstream "/x". false: forwarded unchanged. */
  stripPrefix: boolean;
  title?: string;
  description?: string;
  icon?: string;
  color?: string;
  order?: number;
  /** Absolute public path prefixes that skip portal auth. */
  bypass?: string[];
  /** Absolute root-level path prefixes forwarded to this app unchanged. */
  rootAliases?: string[];
}

export interface PortalConfig {
  enabled: boolean;
  port: number;
  title: string;
  publicUrl: string;
  sessionDays: number;
  /** scrypt hash of the access token; "" until generated. */
  tokenHash: string;
}

export interface ServiceConfig {
  /** Stable id agents use to update/restart this app. */
  id: string;
  name: string;
  /** "external" = not spawned, only health-probed. Default "managed". */
  kind?: ServiceKind;
  /** External only: local health/upstream URL. */
  url?: string;
  /** null/absent = local only. */
  publish?: PublishConfig | null;
  /** Absolute local Windows path to the project folder ("" for external). */
  cwd: string;
  /** Executable or full command line, e.g. "pnpm" or "pnpm dev" ("" for external). */
  command: string;
  /** Extra argv when `command` is an executable. */
  args?: string[];
  env?: ServiceEnv;
  /** Absolute path to a Python venv; its Scripts dir is prepended to PATH. */
  venv?: string;
  /** Extra directories prepended to PATH (Node installs, tool bins). */
  pathPrepend?: string[];
  groupId?: string | null;
  autoStart: boolean;
  restartOnCrash: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupConfig {
  id: string;
  name: string;
  color?: string;
}

export interface AppConfig {
  version: 1;
  port: number;
  token: string;
  logRetentionDays: number;
  autoStartOnBoot: boolean;
  openDashboardOnLaunch: boolean;
  services: ServiceConfig[];
  groups: GroupConfig[];
  portal: PortalConfig;
}

export interface RuntimeState {
  status: ServiceStatus;
  pid: number | null;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  urls: string[];
  restarts: number;
}

export interface ServiceView extends ServiceConfig {
  runtime: RuntimeState;
}

export interface TrayPayload {
  baseUrl: string;
  groups: Array<{
    id: string;
    name: string;
    running: number;
    total: number;
  }>;
  services: Array<{
    id: string;
    name: string;
    status: ServiceStatus;
    groupId: string | null;
    groupName: string | null;
  }>;
}

export type BusEvent =
  | { type: "status"; serviceId: string; status: ServiceStatus; pid: number | null }
  | { type: "log"; serviceId: string; stream: "stdout" | "stderr" | "sys"; line: string; ts: string }
  | { type: "urls"; serviceId: string; urls: string[] }
  | { type: "config" }
  | { type: "portal" };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function bad(status: number, message: string): HttpError {
  return new HttpError(status, message);
}
