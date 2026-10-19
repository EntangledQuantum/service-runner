import { bus } from "../events.ts";
import { saveConfig } from "../config.ts";
import { getConfig } from "../process-manager.ts";
import { originPort } from "../security.ts";
import { bad } from "../types.ts";
import { portalApps } from "./apps.ts";
import { generateToken, hashToken } from "./auth.ts";
import { applyPortal, portalListening, portalSessions } from "./server.ts";
import { tunnelState } from "./tailscale.ts";

/** GET /api/v1/portal */
export async function portalState() {
  const cfg = getConfig();
  const p = cfg.portal;
  const { listening, error } = portalListening();
  return {
    enabled: p.enabled,
    port: p.port,
    title: p.title,
    publicUrl: p.publicUrl,
    sessionDays: p.sessionDays,
    tokenSet: Boolean(p.tokenHash),
    listening,
    localUrl: `http://127.0.0.1:${p.port}`,
    error,
    apps: await portalApps(cfg),
    sessions: portalSessions().list(),
    tunnel: await tunnelState(p.port),
  };
}

/** PATCH /api/v1/portal — validates everything before changing anything. */
export async function patchPortal(body: Record<string, unknown>) {
  const cfg = getConfig();
  const next = { ...cfg.portal };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw bad(400, "enabled must be true or false");
    next.enabled = body.enabled;
  }
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t || t.length > 80) throw bad(400, "title must be 1–80 characters");
    next.title = t;
  }
  if (body.publicUrl !== undefined) {
    const raw = String(body.publicUrl ?? "").trim().replace(/\/+$/, "");
    if (raw) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw bad(400, "publicUrl must be an http(s) URL like https://box.example.ts.net");
      }
      if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash) {
        throw bad(400, "publicUrl must be a plain http(s) URL like https://box.example.ts.net");
      }
    }
    next.publicUrl = raw;
  }
  if (body.sessionDays !== undefined) {
    const n = Number(body.sessionDays);
    if (!Number.isInteger(n) || n < 1 || n > 400) throw bad(400, "sessionDays must be 1–400");
    next.sessionDays = n;
  }
  if (body.port !== undefined) {
    const n = Number(body.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad(400, "port must be 1–65535");
    if (n === cfg.port) throw bad(400, "portal port must differ from the control-panel port");
    const clash = cfg.services.find((s) => s.publish && originPort(s.publish.upstream) === n);
    if (clash) throw bad(400, `port ${n} is the upstream of '${clash.id}'`);
    next.port = n;
  }
  cfg.portal = next;
  saveConfig(cfg);
  bus.emitEvent({ type: "portal" });
  await applyPortal();
  return portalState();
}

/** POST /api/v1/portal/token — plaintext is returned once and never stored. */
export async function regeneratePortalToken(): Promise<{ token: string }> {
  const cfg = getConfig();
  const token = generateToken();
  cfg.portal.tokenHash = await hashToken(token);
  saveConfig(cfg);
  portalSessions().revokeAll();
  bus.emitEvent({ type: "portal" });
  return { token };
}

export function revokePortalSession(id: string): { ok: true } {
  if (!portalSessions().revoke(id)) throw bad(404, `unknown session '${id}'`);
  return { ok: true };
}

export function revokeAllPortalSessions(): { ok: true; revoked: number } {
  return { ok: true, revoked: portalSessions().revokeAll() };
}
