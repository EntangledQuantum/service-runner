# Portal — public app gateway (contract)

Service Runner gains a second, optional HTTP server: the **Portal**. It is the only
thing exposed to the internet (e.g. behind Tailscale Funnel or Cloudflare Tunnel).
The existing control panel on `127.0.0.1:<port>` (default 4780) stays local-only
and is never proxied.

```
Internet ─► tunnel :443 ─► Portal 127.0.0.1:4790
                            ├─ /                 portal home (login → app tiles)
                            ├─ /_portal/*        portal UI assets + portal API
                            └─ /<publish.path>/* reverse proxy to a published app
```

This document is the contract between the backend (`src/`) and the UIs
(`web/` control panel, `portal-web/` public portal). Keep both sides in sync with it.

## Config (`%LOCALAPPDATA%\ServiceRunner\config.json`)

```ts
interface AppConfig {
  // ...existing fields
  portal: PortalConfig;
}

interface PortalConfig {
  enabled: boolean;        // default false
  port: number;            // default 4790, always binds 127.0.0.1
  title: string;           // default "My Apps" — shown on the portal home
  publicUrl: string;       // e.g. "https://box.tailnet.ts.net" ("" if unknown). Informational: UI + agent prompt.
  sessionDays: number;     // default 400 (browser max for cookie lifetime)
  tokenHash: string;       // "" until a token is generated. scrypt hash; plaintext is never stored.
}

interface ServiceConfig {
  // ...existing fields
  kind?: "managed" | "external";   // default "managed". external = not spawned; cwd/command optional/ignored.
  url?: string;                     // external only: local health/upstream URL, e.g. "http://127.0.0.1:8090"
  publish?: PublishConfig | null;   // null/absent = local only (the default for new services)
}

interface PublishConfig {
  path: string;            // "/atlas" — one lowercase segment, [a-z0-9-], not "_portal"
  upstream: string;        // "http://127.0.0.1:47242" — must be loopback, must not be the control-panel port or portal port
  stripPrefix: boolean;    // true: "/atlas/x" → upstream "/x". false: forwarded unchanged (app is base-path aware)
  title?: string;          // tile title (defaults to service name)
  description?: string;    // one short line
  icon?: string;           // single emoji, or an absolute http(s) URL / app-relative path to an image
  color?: string;          // accent hex, e.g. "#7c9cff"
  order?: number;          // tile sort order (ascending), default 100
  bypass?: string[];       // ABSOLUTE public path prefixes that skip portal auth (the app's own auth protects them),
                           // e.g. ["/lifeos/api/v1", "/api/v1", "/health", "/mcp", "/cwa/opds", "/cwa/kobo"]
  rootAliases?: string[];  // ABSOLUTE root-level path prefixes forwarded to this app *unchanged* (no strip),
                           // for apps that emit root-absolute links, e.g. ["/cwa-", "/magicshelf", "/duplicates"]
}
```

Migration: missing `portal` → defaults; missing `kind` → "managed"; missing `publish` → null.
`upsertService` must accept `kind`, `url`, `publish` (validated) and must not require `cwd`/`command`
when `kind === "external"`. External services are never spawned; their `runtime.status` is
`"running"` when a GET to `url` (or `publish.upstream`) answers (any HTTP status) within 2 s, else `"stopped"`,
refreshed every 15 s, emitting normal `status` bus events on change. start/stop/restart on an external
service → 400 "external service is managed outside Service Runner".

## Portal routing (`127.0.0.1:<portal.port>`)

Order of matching for an incoming request path `p`:

1. `/_portal/*` — portal API and static assets (`portal-web/`).
2. `/` and `/index.html` — `portal-web/index.html` (always served; the page itself calls `/_portal/api/me`).
3. Longest matching `publish.path` (exact `/atlas` → 308 redirect to `/atlas/`; `/atlas/...` → proxy).
4. Longest matching `rootAliases` prefix → proxy to that app, path unchanged.
5. **Referer fallback**: if the request has a `Referer` whose same-origin path starts with a published
   `path + "/"`, proxy to that app (path unchanged if `stripPrefix` is false; if `stripPrefix` is true the
   path is forwarded as-is too — the app asked for a root path).
6. Otherwise 404 (portal-styled HTML for browser navigations, JSON otherwise).

Auth applies to 3–5 unless `p` starts with one of that app's `bypass` prefixes (prefix match on a
segment boundary, or exact). Bypass entries are checked across all apps first, so a root-level bypass
like `/api/v1` routes to the app that declared it even without a referer.

Unauthenticated:
- browser navigation (`Accept` contains `text/html`, method GET) → `302 /?next=<urlencoded original path+query>`
- anything else → `401 {"error":"portal login required"}`

Proxy behaviour:
- HTTP and WebSocket upgrade, streaming bodies (SSE must not buffer), no timeouts on streams.
- Strip the portal cookie (`sr_portal`) from the forwarded `Cookie` header.
- Set `X-Forwarded-Proto` (from incoming header, default `https`), `X-Forwarded-Host` (incoming Host),
  `X-Forwarded-For` (append), `X-Forwarded-Prefix: <publish.path>`.
- Preserve `Host` as the upstream's host (`127.0.0.1:port`) — Vite/fastify host checks stay happy.
- Rewrite upstream `Location` headers that point at the upstream origin back to the public origin
  (+ path prefix when `stripPrefix`). Rewrite `Set-Cookie` `Path=/` → `Path=<publish.path>/` only when `stripPrefix` is true.
  Implementation detail: upstream-origin `Location`s become root-relative (`/atlas/login`), so they work whatever
  scheme/host the tunnel uses; with `stripPrefix`, root-relative `Location`s and any root `Path=/x` gain the prefix
  unless already under it. Upstream `Set-Cookie` named `sr_portal` is dropped; loopback `Domain=` attributes are removed.
- Upstream down → 502 portal-styled page "<App> is not running" (JSON `{error:"<App> is not running", detail}` for non-navigations).
- Hop-by-hop headers removed per RFC 7230.

Security:
- Upstreams must be loopback (`127.0.0.1`, `localhost`, `[::1]`), `http:`/`https:`, origin only (no path/query).
  Never proxy to the control-panel port or portal port. (External `url` follows the same rules but may carry a path, e.g. `/health`.)
- `bypass`/`rootAliases` entries: absolute, not `/`, no `.`/`..` segments, never touching `/_portal`, ≤32 each.
  A `bypass` entry may not fall inside another app's `path` (409), since bypass is matched first.
- WebSocket upgrades on authenticated routes are refused (403) when a browser `Origin` does not match `Host`.
- Portal pages send `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`,
  and a CSP for `/` and `/_portal/*` (and portal error pages). Proxied app responses are passed through untouched. The CSP is:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https: http:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
  → **portal-web must not use inline `<script>` or inline event handlers** (external `.js` files only; inline styles are fine).
- Error pages: if `portal-web/error.html` exists it is used as a template with `%%STATUS%%`, `%%TITLE%%`, `%%MESSAGE%%`
  (already HTML-escaped); otherwise a small inline page is served. Applies to portal 404 and 502.
- The exact-path 308 (`/atlas` → `/atlas/`) also requires a session (unauthenticated → login redirect), so it does not reveal apps.
- The control-panel master token is never sent to, readable from, or accepted by the portal.

## Sessions

- Access token: 32 random bytes, base64url, generated by the control panel. Only the scrypt hash is stored.
  Regenerating the token revokes **all** sessions.
- Login creates a session: `{ id, secretHash, deviceName, userAgent, ip, createdAt, lastSeenAt }`
  in `%LOCALAPPDATA%\ServiceRunner\portal-sessions.json` (atomic writes; `lastSeenAt` flushed at most once/min).
- Cookie: `sr_portal=<id>.<secret>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<sessionDays*86400>`.
  Sliding refresh: re-issue the cookie when older than 7 days. `secretHash` is SHA-256 of the 32-byte secret; the file also
  stores `cookieAt` (last cookie issue). A session unused for `sessionDays` expires server-side.
- Login is rate limited: 10 failed attempts / 15 min per client IP (first `X-Forwarded-For` hop, else socket),
  and 50 / 15 min globally. Compare with `timingSafeEqual`.

## Portal API (`/_portal/api/*`, JSON)

| Method | Path | Auth | Body / response |
|---|---|---|---|
| POST | `/_portal/api/login` | — | `{token, deviceName?}` → `200 {ok:true}` + cookie · `401 {error}` · `429 {error, retryAfterSec}` |
| POST | `/_portal/api/logout` | session | revokes this session, clears cookie → `{ok:true}` |
| GET | `/_portal/api/me` | session | `{ok:true, session:{id, deviceName, createdAt}}` · `401` |
| GET | `/_portal/api/apps` | session | `{title, apps: PortalApp[]}` |

```ts
interface PortalApp {
  id: string; name: string; path: string;        // "/atlas/"
  description: string; icon: string; color: string;
  status: "up" | "down";                         // live upstream probe (cached ≤10 s)
}
// icon is one of: "" | an emoji | an absolute http(s) URL | a root-absolute public path
// (app-relative icons are resolved server-side: "favicon.svg" on /atlas → "/atlas/favicon.svg").
// name = publish.title ?? service name. Only enabled services with a publish block are listed/routed.
```

## Control-panel API additions (`127.0.0.1:4780`, Bearer master token, local only)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/portal` | `{enabled, port, title, publicUrl, sessionDays, tokenSet, listening, localUrl, error, apps: PortalApp[], sessions: SessionView[], tunnel: TunnelState}` — `error` is `null` or why the listener could not bind (e.g. port in use). `tunnel` reports Tailscale: `{provider, installed, running, dnsName, funnelToPortal, publicUrl, command, installUrl}` (see `src/portal/tailscale.ts`). |
| PATCH | `/api/v1/portal` | `{enabled?, title?, publicUrl?, sessionDays?, port?}` → same shape as GET. Toggling `enabled` starts/stops the listener live. |
| POST | `/api/v1/portal/token` | generates a new access token → `{token}` (plaintext, shown once); revokes all sessions |
| DELETE | `/api/v1/portal/sessions/:id` | revoke one → `{ok:true}` |
| DELETE | `/api/v1/portal/sessions` | revoke all → `{ok:true, revoked:n}` |

`SessionView = {id, deviceName, userAgent, ip, createdAt, lastSeenAt}` (no secrets).
SSE `/api/v1/events` additionally emits `{type:"portal"}` whenever portal config or sessions change.

## Agent prompt

The existing prompt keeps registering services as local-only. It gains one extra sentence telling agents
how to publish (`publish` block in the same PUT, with the base-path requirement) and to only do so when
the user asks for the app to be public.

## Running an isolated instance (development)

`SERVICE_RUNNER_DATA_DIR=<absolute dir>` replaces `%LOCALAPPDATA%\ServiceRunner` (config, logs, sessions, pid).
`--no-tray` skips the tray icon and the Startup-shortcut install. Together with a different `port` / `portal.port`
and `autoStartOnBoot:false` in that dir's `config.json`, this runs a second instance next to the real one:
`SERVICE_RUNNER_DATA_DIR=C:\tmp\sr pnpm start -- --foreground --no-tray`.
