import {
  Agent as HttpAgent,
  request as httpRequest,
  validateHeaderName,
  validateHeaderValue,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
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

/** Drop headers Node refuses to send, so one odd upstream header can't fail the response. */
function validHeaders(h: OutgoingHttpHeaders): OutgoingHttpHeaders {
  for (const [k, v] of Object.entries(h)) {
    try {
      validateHeaderName(k);
      if (v === undefined) throw new Error("no value");
      for (const one of Array.isArray(v) ? v : [v]) validateHeaderValue(k, String(one));
    } catch {
      delete h[k];
    }
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
  return validHeaders(h);
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
  // Socket callbacks run outside any try/catch: a throw here would take down the whole
  // supervisor and every app with it, so a failure ends only this request.
  preq.on("response", (pres) => {
    pres.on("error", () => res.destroy());
    try {
      // The reason phrase is optional, and Node throws on odd characters in it — drop it.
      res.writeHead(pres.statusCode ?? 502, responseHeaders(pres, app, extraCookies));
      res.flushHeaders();
      pres.pipe(res);
    } catch (err) {
      console.warn(`Portal: bad response from ${app.name}:`, (err as Error).message);
      pres.destroy();
      if (!res.headersSent) onDown();
      else res.destroy();
    }
  });
  preq.on("error", () => {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) onDown();
    else res.destroy();
  });
  res.on("close", () => {
    if (!res.writableFinished) preq.destroy();
  });
  req.on("error", () => preq.destroy());
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

  const tunnel = (pres: IncomingMessage, psock: Socket, phead: Buffer) => {
    const lines = [`HTTP/1.1 ${pres.statusCode ?? 101} Switching Protocols`];
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
    socket.on("close", () => psock.destroy());
    psock.on("close", () => socket.destroy());
    psock.pipe(socket);
    socket.pipe(psock);
  };

  // Upstream answered without upgrading: relay status + body, then close.
  const relay = (pres: IncomingMessage) => {
    const h = stripHopByHop({ ...pres.headers } as Record<string, unknown>);
    delete h["content-length"];
    const lines = [`HTTP/1.1 ${pres.statusCode}`];
    for (const [k, v] of Object.entries(h)) {
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${String(one)}`);
    }
    lines.push("Connection: close");
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    pres.pipe(socket);
  };

  // Socket callbacks: contain any failure to this one connection.
  preq.on("upgrade", (pres, psock, phead) => {
    psock.on("error", () => socket.destroy());
    try {
      tunnel(pres, psock, phead);
    } catch (err) {
      console.warn(`Portal: bad upgrade from ${app.name}:`, (err as Error).message);
      psock.destroy();
      socket.destroy();
    }
  });
  preq.on("response", (pres) => {
    pres.on("error", () => socket.destroy());
    try {
      relay(pres);
    } catch (err) {
      console.warn(`Portal: bad response from ${app.name}:`, (err as Error).message);
      pres.destroy();
      socket.destroy();
    }
  });
  preq.on("error", () => rawResponse(socket, 502, `${app.name} is not running`));
  preq.end();
}
