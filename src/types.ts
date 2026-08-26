export type ServiceStatus = "stopped" | "starting" | "running" | "stopping" | "crashed";

export interface ServiceEnv {
  [key: string]: string;
}

export interface ServiceConfig {
  /** Stable id agents use to update/restart this app. */
  id: string;
  name: string;
  /** Absolute local Windows path to the project folder. */
  cwd: string;
  /** Executable or full command line, e.g. "pnpm" or "pnpm dev". */
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
  | { type: "config" };

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
