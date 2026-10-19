import { isLoopbackHost } from "../security.ts";
import { COOKIE_NAME } from "./auth.ts";
import { matchesSegment, RESERVED_PREFIX } from "./publish.ts";

/** A published app as the router sees it. */
export interface RouteApp {
  id: string;
  name: string;
  path: string; // "/atlas"
  upstream: string; // "http://127.0.0.1:3000"
  stripPrefix: boolean;
  bypass: string[];
  rootAliases: string[];
}

export type Route =
  | { kind: "portal" } // /_portal/*
  | { kind: "home" } // / and /index.html
  | { kind: "redirect"; app: RouteApp; location: string; auth: boolean }
  | { kind: "proxy"; app: RouteApp; upstreamPath: string; auth: boolean; via: "path" | "bypass" | "alias" | "referer" }
  | { kind: "notfound" };

function underApp(p: string, app: RouteApp): boolean {
  return p === app.path || p.startsWith(app.path + "/");
}

function forward(p: string, search: string, app: RouteApp): string {
  const path = app.stripPrefix && p.startsWith(app.path + "/") ? p.slice(app.path.length) : p;
  return path + search;
}

function longest<T>(items: Array<[T, string]>): T | null {
  let best: T | null = null;
  let len = -1;
  for (const [item, prefix] of items) {
    if (prefix.length > len) {
      best = item;
      len = prefix.length;
    }
  }
  return best;
}

/**
 * Spec routing order: /_portal, home, bypass (all apps, no auth), longest publish path,
 * longest rootAlias, same-origin Referer fallback, 404.
 * `pathname` must already be WHATWG-normalized (no dot segments).
 */
export function resolveRoute(
  pathname: string,
  search: string,
  apps: RouteApp[],
  referer?: { path: string } | null,
): Route {
  const p = pathname;
  if (p === RESERVED_PREFIX || p.startsWith(RESERVED_PREFIX + "/")) return { kind: "portal" };
  if (p === "/" || p === "/index.html") return { kind: "home" };

  const target = (app: RouteApp, auth: boolean, via: "path" | "bypass" | "alias" | "referer"): Route =>
    p === app.path
      ? { kind: "redirect", app, location: app.path + "/" + search, auth }
      : { kind: "proxy", app, upstreamPath: forward(p, search, app), auth, via };

  const bypassed = longest(apps.flatMap((a) => a.bypass.filter((b) => matchesSegment(p, b)).map((b) => [a, b] as [RouteApp, string])));
  if (bypassed) return target(bypassed, false, "bypass");

  const byPath = longest(apps.filter((a) => underApp(p, a)).map((a) => [a, a.path] as [RouteApp, string]));
  if (byPath) return target(byPath, true, "path");

  const alias = longest(apps.flatMap((a) => a.rootAliases.filter((r) => p.startsWith(r)).map((r) => [a, r] as [RouteApp, string])));
  if (alias) return { kind: "proxy", app: alias, upstreamPath: p + search, auth: true, via: "alias" };

  if (referer) {
    const ref = longest(apps.filter((a) => referer.path.startsWith(a.path + "/")).map((a) => [a, a.path] as [RouteApp, string]));
    if (ref) return { kind: "proxy", app: ref, upstreamPath: p + search, auth: true, via: "referer" };
  }
  return { kind: "notfound" };
}

/** Referer path when it is same-origin with the request Host, else null. */
export function sameOriginRefererPath(referer: string | undefined, host: string | undefined): { path: string } | null {
  if (!referer || !host) return null;
  try {
    const u = new URL(referer);
    if (u.host.toLowerCase() !== host.toLowerCase()) return null;
    return { path: u.pathname };
  } catch {
    return null;
  }
}

// ── header rewriting ───────────────────────────────────────────────────────

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** Drop RFC 7230 hop-by-hop headers, including any named in Connection. Mutates and returns `h`. */
export function stripHopByHop<T extends Record<string, unknown>>(h: T): T {
  const conn = h["connection"];
  const named = (Array.isArray(conn) ? conn.join(",") : typeof conn === "string" ? conn : "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const k of [...HOP_BY_HOP, ...named]) delete h[k];
  return h;
}

/** Remove the portal session cookie before forwarding; undefined when nothing is left. */
export function stripPortalCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && s.slice(0, s.indexOf("=") < 0 ? s.length : s.indexOf("=")).trim() !== COOKIE_NAME);
  return kept.length ? kept.join("; ") : undefined;
}

function sameUpstream(u: URL, upstream: string): boolean {
  const up = new URL(upstream);
  const port = (x: URL) => x.port || (x.protocol === "https:" ? "443" : "80");
  return (
    (u.protocol === "http:" || u.protocol === "https:") &&
    port(u) === port(up) &&
    (u.hostname === up.hostname || (isLoopbackHost(u.hostname) && isLoopbackHost(up.hostname)) || u.hostname === "0.0.0.0")
  );
}

/**
 * Upstream Location → public. Absolute URLs on the upstream origin become root-relative
 * (the browser resolves them against the public origin, whatever the tunnel's scheme/host).
 * With stripPrefix, root-relative paths gain the app prefix unless already under it.
 */
export function rewriteLocation(loc: string, app: Pick<RouteApp, "path" | "upstream" | "stripPrefix">): string {
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:/i.test(loc) || loc.startsWith("//")) {
    let u: URL;
    try {
      u = new URL(loc, app.upstream);
    } catch {
      return loc;
    }
    if (!sameUpstream(u, app.upstream)) return loc;
    path = u.pathname + u.search + u.hash;
  } else if (loc.startsWith("/")) {
    path = loc;
  } else {
    return loc; // relative — resolves correctly under the prefix already
  }
  if (app.stripPrefix && !(path === app.path || path.startsWith(app.path + "/") || path.startsWith(app.path + "?"))) {
    path = app.path + path;
  }
  return path;
}

/**
 * Upstream Set-Cookie → public. Drops attempts to set the portal cookie, drops loopback Domain=,
 * and with stripPrefix scopes root Paths under the prefix (Path=/ → Path=/atlas/).
 */
export function rewriteSetCookie(sc: string, app: Pick<RouteApp, "path" | "stripPrefix">): string | null {
  const parts = sc.split(";");
  const name = parts[0].slice(0, parts[0].indexOf("=") < 0 ? parts[0].length : parts[0].indexOf("=")).trim();
  if (name === COOKIE_NAME) return null;
  const out: string[] = [parts[0]];
  for (const raw of parts.slice(1)) {
    const attr = raw.trim();
    const eq = attr.indexOf("=");
    const key = (eq < 0 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    const val = eq < 0 ? "" : attr.slice(eq + 1).trim();
    if (key === "domain" && isLoopbackHost(val.replace(/^\./, ""))) continue;
    if (key === "path" && app.stripPrefix && val.startsWith("/") && !(val === app.path || val.startsWith(app.path + "/"))) {
      out.push(`Path=${val === "/" ? app.path + "/" : app.path + val}`);
      continue;
    }
    out.push(attr);
  }
  return out.join("; ");
}
