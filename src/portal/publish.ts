import { assertLoopbackOrigin } from "../security.ts";
import { bad, type PublishConfig, type ServiceConfig } from "../types.ts";

const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const PREFIX_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]*$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MAX_PREFIXES = 32;

export const RESERVED_PREFIX = "/_portal";

/** "/atlas" — accepts "atlas", "/atlas", "/atlas/". */
export function assertPublishPath(input: unknown): string {
  const raw = typeof input === "string" ? input.trim().replace(/^\/+|\/+$/g, "") : "";
  if (!SEGMENT_RE.test(raw)) {
    throw bad(400, 'publish.path must be one lowercase segment of a-z, 0-9 and dash, e.g. "/atlas"');
  }
  return "/" + raw;
}

/** Segment-boundary prefix match: "/api/v1" matches "/api/v1" and "/api/v1/x", not "/api/v1x". */
export function matchesSegment(path: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return path.startsWith(prefix) || path === prefix.slice(0, -1);
  return path === prefix || path.startsWith(prefix + "/");
}

function assertPrefixList(input: unknown, field: string): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw bad(400, `${field} must be an array of absolute paths`);
  if (input.length > MAX_PREFIXES) throw bad(400, `${field} allows at most ${MAX_PREFIXES} entries`);
  const out: string[] = [];
  for (const v of input) {
    const p = typeof v === "string" ? v.trim() : "";
    if (!p.startsWith("/") || p === "/" || p.length > 200 || !PREFIX_RE.test(p) || p.includes("//")) {
      throw bad(400, `${field}: "${String(v)}" must be an absolute path like "/api/v1" (not "/")`);
    }
    if (p.split("/").some((seg) => seg === "." || seg === "..")) throw bad(400, `${field}: "${p}" cannot contain . or ..`);
    if (p.startsWith(RESERVED_PREFIX) || RESERVED_PREFIX.startsWith(p)) {
      throw bad(400, `${field}: "${p}" collides with the reserved ${RESERVED_PREFIX} path`);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out.length ? out : undefined;
}

function optText(input: unknown, field: string, max: number): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input !== "string") throw bad(400, `${field} must be a string`);
  const t = input.trim();
  if (t.length > max) throw bad(400, `${field} must be at most ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(t)) throw bad(400, `${field} cannot contain control characters`);
  return t || undefined;
}

function optIcon(input: unknown): string | undefined {
  const t = optText(input, "publish.icon", 500);
  if (!t) return undefined;
  if (t.includes(":")) {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      throw bad(400, "publish.icon must be an emoji, an http(s) URL, or an app-relative image path");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw bad(400, "publish.icon URL must be http(s)");
  } else if (/[<>"'`\s\\]/.test(t)) {
    throw bad(400, "publish.icon contains characters that are not allowed");
  }
  return t;
}

export interface PublishContext {
  /** Control-panel and portal ports — never valid upstreams. */
  reservedPorts: number[];
  /** Other services' publish blocks, for uniqueness/conflict checks. */
  others?: Array<Pick<ServiceConfig, "id" | "publish">>;
}

/** Validate a `publish` body. null/undefined → null (local only). */
export function assertPublish(input: unknown, ctx: PublishContext): PublishConfig | null {
  if (input === undefined || input === null || input === false) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw bad(400, "publish must be an object or null");
  const b = input as Record<string, unknown>;
  const path = assertPublishPath(b.path);
  const upstream = assertLoopbackOrigin(b.upstream, "publish.upstream", ctx.reservedPorts);
  if (b.stripPrefix !== undefined && typeof b.stripPrefix !== "boolean") throw bad(400, "publish.stripPrefix must be true or false");
  const color = optText(b.color, "publish.color", 9);
  if (color && !COLOR_RE.test(color)) throw bad(400, 'publish.color must be a hex color like "#7c9cff"');
  let order: number | undefined;
  if (b.order !== undefined && b.order !== null) {
    order = Number(b.order);
    if (!Number.isInteger(order) || Math.abs(order) > 1e6) throw bad(400, "publish.order must be an integer");
  }
  const out: PublishConfig = {
    path,
    upstream,
    stripPrefix: b.stripPrefix !== false,
    title: optText(b.title, "publish.title", 80),
    description: optText(b.description, "publish.description", 200),
    icon: optIcon(b.icon),
    color,
    order,
    bypass: assertPrefixList(b.bypass, "publish.bypass"),
    rootAliases: assertPrefixList(b.rootAliases, "publish.rootAliases"),
  };
  for (const k of Object.keys(out) as Array<keyof PublishConfig>) {
    if (out[k] === undefined) delete out[k];
  }
  assertNoConflicts(out, ctx.others ?? []);
  return out;
}

function assertNoConflicts(p: PublishConfig, others: Array<Pick<ServiceConfig, "id" | "publish">>): void {
  for (const o of others) {
    const q = o.publish;
    if (!q) continue;
    if (q.path === p.path) throw bad(409, `publish.path ${p.path} is already used by service '${o.id}'`);
    // Bypass entries route before publish paths, so they must not reach into another app.
    for (const b of p.bypass ?? []) {
      if (matchesSegment(b, q.path)) throw bad(409, `publish.bypass "${b}" is inside '${o.id}' (${q.path})`);
    }
    for (const b of q.bypass ?? []) {
      if (matchesSegment(b, p.path)) throw bad(409, `publish.path ${p.path} is covered by a bypass of '${o.id}' ("${b}")`);
    }
  }
}
