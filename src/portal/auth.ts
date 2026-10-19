import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const COOKIE_NAME = "sr_portal";
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
const DAY = 86_400_000;
const REFRESH_AFTER = 7 * DAY;
const LAST_SEEN_FLUSH = 60_000;
const MAX_SESSIONS = 500;

// ── access token ────────────────────────────────────────────────────────────

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** "scrypt$N$r$p$salt$hash" (base64url). */
export async function hashToken(token: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(token, salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyToken(token: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || typeof token !== "string" || !token) return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64url");
  const want = Buffer.from(parts[5], "base64url");
  if (!want.length || !Number.isInteger(N) || N > 1 << 20) return false;
  try {
    const got = await scryptAsync(token.slice(0, 256), salt, want.length, { N, r, p, maxmem: 256 * N * r + 1024 });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// ── rate limiting ───────────────────────────────────────────────────────────

export class LoginLimiter {
  private perIp = new Map<string, number[]>();
  private global: number[] = [];
  constructor(
    private readonly ipMax = 10,
    private readonly globalMax = 50,
    private readonly windowMs = 15 * 60_000,
  ) {}

  /** null = allowed; otherwise seconds until the oldest failure in the window expires. */
  check(ip: string, now = Date.now()): number | null {
    const cut = now - this.windowMs;
    this.global = this.global.filter((t) => t > cut);
    const mine = (this.perIp.get(ip) ?? []).filter((t) => t > cut);
    if (mine.length) this.perIp.set(ip, mine);
    else this.perIp.delete(ip);
    const wait = (list: number[]) => Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
    if (mine.length >= this.ipMax) return wait(mine);
    if (this.global.length >= this.globalMax) return wait(this.global);
    return null;
  }

  /** Record a failed (or in-flight) attempt; returns its stamp for `undo`. */
  fail(ip: string, now = Date.now()): number {
    this.global.push(now);
    const list = this.perIp.get(ip) ?? [];
    list.push(now);
    this.perIp.set(ip, list);
    if (this.perIp.size > 10_000) {
      const first = this.perIp.keys().next().value;
      if (first !== undefined) this.perIp.delete(first);
    }
    return now;
  }

  /** A login succeeded: forget that attempt and this IP's earlier failures. */
  undo(ip: string, stamp: number): void {
    const i = this.global.indexOf(stamp);
    if (i >= 0) this.global.splice(i, 1);
    this.perIp.delete(ip);
  }
}

// ── sessions ────────────────────────────────────────────────────────────────

export interface SessionRecord {
  id: string;
  secretHash: string;
  deviceName: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  lastSeenAt: string;
  /** When the cookie was last (re)issued — drives sliding refresh. */
  cookieAt: string;
}

export interface SessionView {
  id: string;
  deviceName: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  lastSeenAt: string;
}

export function sessionView(s: SessionRecord): SessionView {
  return {
    id: s.id,
    deviceName: s.deviceName,
    userAgent: s.userAgent,
    ip: s.ip,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
  };
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export interface VerifyResult {
  session: SessionRecord;
  /** Cookie value to re-issue (sliding refresh), or null. */
  refresh: string | null;
}

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string | null,
    private readonly sessionDays: () => number,
    private readonly onChange: () => void = () => {},
  ) {
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { sessions?: SessionRecord[] };
      for (const s of raw.sessions ?? []) {
        if (s && typeof s.id === "string" && typeof s.secretHash === "string") {
          this.sessions.set(s.id, { ...s, cookieAt: s.cookieAt ?? s.createdAt });
        }
      }
      this.prune();
    } catch (err) {
      console.warn("Service Runner: portal-sessions.json unreadable, starting empty:", (err as Error).message);
    }
  }

  save(): void {
    this.dirty = false;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: [...this.sessions.values()] }, null, 2) + "\n", "utf8");
    renameSync(tmp, this.file);
  }

  /** Flush throttled lastSeenAt updates at most once a minute. */
  startFlusher(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), LAST_SEEN_FLUSH);
    this.timer.unref();
  }

  flush(): void {
    if (!this.dirty) return;
    try {
      this.save();
      this.onChange();
    } catch (err) {
      console.warn("Service Runner: could not save portal sessions:", (err as Error).message);
    }
  }

  private expired(s: SessionRecord, now: number): boolean {
    return now - Date.parse(s.lastSeenAt) > this.sessionDays() * DAY;
  }

  private prune(now = Date.now()): boolean {
    let changed = false;
    for (const s of this.sessions.values()) {
      if (this.expired(s, now)) {
        this.sessions.delete(s.id);
        changed = true;
      }
    }
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
      for (const s of oldest.slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(s.id);
      changed = true;
    }
    return changed;
  }

  /** Returns the cookie value `<id>.<secret>`. */
  create(info: { deviceName: string; userAgent: string; ip: string }, now = Date.now()): { cookie: string; session: SessionRecord } {
    const id = randomBytes(12).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const iso = new Date(now).toISOString();
    const session: SessionRecord = {
      id,
      secretHash: sha256(secret).toString("hex"),
      deviceName: info.deviceName,
      userAgent: info.userAgent.slice(0, 300),
      ip: info.ip,
      createdAt: iso,
      lastSeenAt: iso,
      cookieAt: iso,
    };
    this.sessions.set(id, session);
    this.prune(now);
    this.save();
    this.onChange();
    return { cookie: `${id}.${secret}`, session };
  }

  verify(cookieValue: string | undefined, now = Date.now()): VerifyResult | null {
    if (!cookieValue) return null;
    const dot = cookieValue.indexOf(".");
    if (dot < 1) return null;
    const id = cookieValue.slice(0, dot);
    const secret = cookieValue.slice(dot + 1);
    const s = this.sessions.get(id);
    if (!s || !secret) return null;
    const want = Buffer.from(s.secretHash, "hex");
    const got = sha256(secret);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (this.expired(s, now)) {
      this.revoke(id);
      return null;
    }
    if (now - Date.parse(s.lastSeenAt) >= LAST_SEEN_FLUSH) {
      s.lastSeenAt = new Date(now).toISOString();
      this.dirty = true;
    }
    let refresh: string | null = null;
    if (now - Date.parse(s.cookieAt) > REFRESH_AFTER) {
      s.cookieAt = new Date(now).toISOString();
      this.dirty = true;
      refresh = cookieValue;
    }
    return { session: s, refresh };
  }

  revoke(id: string): boolean {
    const ok = this.sessions.delete(id);
    if (ok) {
      this.save();
      this.onChange();
    }
    return ok;
  }

  revokeAll(): number {
    const n = this.sessions.size;
    this.sessions.clear();
    this.save();
    this.onChange();
    return n;
  }

  list(): SessionView[] {
    this.prune();
    return [...this.sessions.values()]
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map(sessionView);
  }
}

// ── cookies ─────────────────────────────────────────────────────────────────

/** All values of `name` in a Cookie header (a client may send duplicates). */
export function readCookies(header: string | undefined, name = COOKIE_NAME): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(value: string, sessionDays: number): string {
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${sessionDays * 86400}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** "Chrome on Windows"-style label when the client sends no device name. */
export function deviceLabel(ua: string): string {
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\//.test(ua) ? "Opera" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" :
    /curl\//i.test(ua) ? "curl" : "Browser";
  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS" :
    /Android/.test(ua) ? "Android" :
    /Windows/.test(ua) ? "Windows" :
    /Mac OS X|Macintosh/.test(ua) ? "macOS" :
    /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
