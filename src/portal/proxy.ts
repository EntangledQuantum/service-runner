import { Agent as HttpAgent, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { rewriteLocation, rewriteSetCookie, stripHopByHop, stripPortalCookie, type RouteApp } from "./routing.ts";

// Own agents: no socket timeouts, so SSE and long polls stay open.
const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 256 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 256, rejectUnauthorized: false });

export function clientAddr(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v ?? "").split(",")[0].trim();
}

export function forwardHeaders(req: IncomingMessage, app: RouteApp, upgrade = false): OutgoingHttpHeaders {
  const h: OutgoingHttpHeaders = { ...req.headers };
  stripHopByHop(h);
  const cookie = stripPortalCookie(req.headers.cookie);
  if (cookie) h.cookie = cookie;
  else delete h.cookie;
  h.host = new URL(app.upstream).host;
  h["x-forwarded-proto"] = first(req.headers["x-forwarded-proto"]) || "https";
  h["x-forwarded-host"] = req.headers.host ?? "";
  const prior = req.headers["x-forwarded-for"];
  const addr = clientAddr(req);
  h["x-forwarded-for"] = prior ? `${Array.isArray(prior) ? prior.join(", ") : prior}, ${addr}` : addr;
  h["x-forwarded-prefix"] = app.path;
  if (upgrade) {
    h.connection = "Upgrade";
    h.upgrade = req.headers.upgrade;
  }
  return h;
}

function responseHeaders(pres: IncomingMessage, app: RouteApp, extraCookies: string[]): OutgoingHttpHeaders {
  const h: OutgoingHttpHeaders = { ...pres.headers };
  stripHopByHop(h);
  const loc = pres.headers.location;
  if (loc) h.location = rewriteLocation(loc, app);
  const cookies = (pres.headers["set-cookie"] ?? [])
    .map((c) => rewriteSetCookie(c, app))
    .filter((c): c is string => c !== null)
    .concat(extraCookies);
  if (cookies.length) h["set-cookie"] = cookies;
  else delete h["set-cookie"];
  return h;
}

function target(app: RouteApp, path: string) {
  const u = new URL(app.upstream);
  const https = u.protocol === "https:";
  return {
    request: https ? httpsRequest : httpRequest,
    agent: https ? httpsAgent : httpAgent,
    opts: { hostname: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || (https ? 443 : 80)), path },
  };
}

/** Streams req → upstream → res. `onDown` runs when the upstream can't be reached before headers are sent. */
export function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  app: RouteApp,
  upstreamPath: string,
  extraCookies: string[],
  onDown: () => void,
): void {
  const t = target(app, upstreamPath);
  const preq = t.request({
    ...t.opts,
    method: req.method,
    headers: forwardHeaders(req, app),
    agent: t.agent,
    rejectUnauthorized: false,
  });
  preq.on("response", (pres) => {
    res.writeHead(pres.statusCode ?? 502, pres.statusMessage, responseHeaders(pres, app, extraCookies));
    res.flushHeaders();
    pres.pipe(res);
    pres.on("error", () => res.destroy());
  });
  preq.on("error", () => {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) onDown();
    else res.destroy();
  });
  res.on("close", () => {
    if (!res.writableFinished) preq.destroy();
  });
  req.pipe(preq);
}

export function rawResponse(socket: Duplex, status: number, text: string): void {
  if (!socket.writable) return;
  const reason = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 502: "Bad Gateway" }[status] ?? "Error";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`,
  );
}

/** WebSocket (or any Upgrade) tunnel. */
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, app: RouteApp, upstreamPath: string): void {
  const t = target(app, upstreamPath);
  const preq = t.request({
    ...t.opts,
    method: req.method,
    headers: forwardHeaders(req, app, true),
    agent: false,
    rejectUnauthorized: false,
  });
  socket.on("error", () => preq.destroy());

  preq.on("upgrade", (pres, psock, phead) => {
    const lines = [`HTTP/1.1 ${pres.statusCode ?? 101} ${pres.statusMessage ?? "Switching Protocols"}`];
    for (let i = 0; i < pres.rawHeaders.length; i += 2) {
      const k = pres.rawHeaders[i];
      let v: string | null = pres.rawHeaders[i + 1];
      if (k.toLowerCase() === "set-cookie") v = rewriteSetCookie(v, app);
      if (v !== null) lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (phead.length) socket.write(phead);
    if (head.length) psock.write(head);
    psock.setNoDelay(true);
    psock.setTimeout(0);
    psock.on("error", () => socket.destroy());
    socket.on("close", () => psock.destroy());
    psock.on("close", () => socket.destroy());
    psock.pipe(socket);
    socket.pipe(psock);
  });

  // Upstream answered without upgrading: relay status + body, then close.
  preq.on("response", (pres) => {
    const h = stripHopByHop({ ...pres.headers } as Record<string, unknown>);
    delete h["content-length"];
    const lines = [`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage ?? ""}`];
    for (const [k, v] of Object.entries(h)) {
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${String(one)}`);
    }
    lines.push("Connection: close");
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    pres.pipe(socket);
  });

  preq.on("error", () => rawResponse(socket, 502, `${app.name} is not running`));
  preq.end();
}
