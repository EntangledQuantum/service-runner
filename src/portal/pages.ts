import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PORTAL_WEB_DIR } from "../paths.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export const PORTAL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https: http:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Headers for everything the portal itself serves (not for proxied app responses). */
export function securityHeaders(): Record<string, string> {
  return {
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": PORTAL_CSP,
  };
}

/** Resolve `rel` under `root`, or null if it escapes, is hidden, or uses Windows tricks (ADS, drive, UNC). */
export function safeJoin(root: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (!decoded || /[\0\\:]/.test(decoded) || decoded.startsWith("/")) return null;
  if (decoded.split("/").some((seg) => seg === ".." || (seg.startsWith(".") && seg.length > 0))) return null;
  const base = resolve(root);
  const full = resolve(base, decoded);
  if (!full.startsWith(base + sep)) return null;
  return full;
}

export function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders(),
    ...extra,
  });
  res.end(JSON.stringify(body));
}

export function wantsHtml(req: IncomingMessage): boolean {
  return String(req.headers.accept ?? "").includes("text/html");
}

/** /_portal/<rel> → portal-web/<rel>. */
export function serveAsset(req: IncomingMessage, res: ServerResponse, rel: string): void {
  const full = safeJoin(PORTAL_WEB_DIR, rel);
  if (!full || !existsSync(full) || !statSync(full).isFile()) {
    notFound(req, res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
    ...securityHeaders(),
  });
  res.end(req.method === "HEAD" ? undefined : readFileSync(full));
}

export function serveHome(req: IncomingMessage, res: ServerResponse): void {
  const file = resolve(PORTAL_WEB_DIR, "index.html");
  const html = existsSync(file)
    ? readFileSync(file)
    : page("Portal", "Portal UI not installed", "portal-web/index.html is missing from the Service Runner folder.");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders() });
  res.end(req.method === "HEAD" ? undefined : html);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Error page. If portal-web/error.html exists it is used as a template with
 * %%STATUS%%, %%TITLE%% and %%MESSAGE%% (HTML-escaped); otherwise a small inline page.
 */
export function page(status: number | string, title: string, message: string): string {
  const tpl = resolve(PORTAL_WEB_DIR, "error.html");
  if (existsSync(tpl)) {
    try {
      return readFileSync(tpl, "utf8")
        .replaceAll("%%STATUS%%", esc(String(status)))
        .replaceAll("%%TITLE%%", esc(title))
        .replaceAll("%%MESSAGE%%", esc(message));
    } catch {
      /* fall through */
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e8ee}
@media (prefers-color-scheme:light){body{background:#f6f7f9;color:#1b1e25}}main{max-width:32rem;padding:2rem;text-align:center}
.s{font-size:.8rem;letter-spacing:.12em;opacity:.55}h1{font-size:1.4rem;margin:.4rem 0}p{opacity:.75}a{color:#7c9cff}</style></head>
<body><main><div class="s">${esc(String(status))}</div><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Back to portal</a></p></main></body></html>`;
}

/** HTML for browser navigations, JSON otherwise. */
export function errorResponse(req: IncomingMessage, res: ServerResponse, status: number, title: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (wantsHtml(req)) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders() });
    res.end(page(status, title, message));
    return;
  }
  json(res, status, { error: title, detail: message });
}

export function notFound(req: IncomingMessage, res: ServerResponse): void {
  errorResponse(req, res, 404, "Not found", "Nothing is published at this address.");
}
