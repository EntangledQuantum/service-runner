import { configDirPrompt, logsDirPrompt } from "./paths.ts";
import type { AppConfig } from "./types.ts";

export function baseUrl(cfg: AppConfig): string {
  return `http://127.0.0.1:${cfg.port}`;
}

/** Two-to-three line prompt an agent can paste. Values follow this machine. */
export function agentPrompt(cfg: AppConfig): string {
  const url = baseUrl(cfg);
  return [
    `Service Runner is the local production host for long-running apps on this Windows machine (${url}). Do not leave a terminal open — register the app so it survives reboots and can be restarted after you change code.`,
    `Add or update with PUT ${url}/api/v1/services/<stable-id> JSON {"name":"<app>","cwd":"<absolute local path>","command":"<how to run, e.g. pnpm dev>","autoStart":true} and header Authorization: Bearer ${cfg.token}. Restart after changes: POST ${url}/api/v1/services/<id>/restart (same header).`,
    `Local Windows paths only — no URLs, no network shares. Logs: ${logsDirPrompt()}\\<id>\\ (last ${cfg.logRetentionDays} days). Config: ${configDirPrompt()}\\config.json (not in git).`,
  ].join(" ");
}

export function promptPayload(cfg: AppConfig) {
  const url = baseUrl(cfg);
  return {
    text: agentPrompt(cfg),
    baseUrl: url,
    token: cfg.token,
    logDir: logsDirPrompt(),
    configDir: configDirPrompt(),
    logRetentionDays: cfg.logRetentionDays,
    endpoints: {
      upsert: `PUT ${url}/api/v1/services/:id`,
      restart: `POST ${url}/api/v1/services/:id/restart`,
      stop: `POST ${url}/api/v1/services/:id/stop`,
      start: `POST ${url}/api/v1/services/:id/start`,
      logs: `GET ${url}/api/v1/services/:id/logs`,
      list: `GET ${url}/api/v1/services`,
    },
    example: {
      method: "PUT",
      url: `${url}/api/v1/services/my-app`,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: {
        name: "My App",
        cwd: "E:\\\\My_Project\\\\my-app",
        command: "pnpm dev",
        autoStart: true,
      },
    },
  };
}
