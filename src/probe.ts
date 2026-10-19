import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** true when a GET answers with any HTTP status within `timeoutMs`. Loopback URLs only (validated by callers). */
export function probeUrl(url: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (up: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(up);
    };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      { method: "GET", agent: false, rejectUnauthorized: false, headers: { "User-Agent": "ServiceRunner-probe" } },
      (res) => {
        res.resume();
        finish(true);
      },
    );
    const timer = setTimeout(() => finish(false), timeoutMs);
    req.on("error", () => finish(false));
    req.end();
  });
}

const cache = new Map<string, { at: number; up: boolean; pending?: Promise<boolean> }>();

/** probeUrl with a short cache so tile lists don't hammer upstreams. */
export function probeCached(url: string, maxAgeMs = 10_000): Promise<boolean> {
  const hit = cache.get(url);
  const now = Date.now();
  if (hit?.pending) return hit.pending;
  if (hit && now - hit.at <= maxAgeMs) return Promise.resolve(hit.up);
  const pending = probeUrl(url).then((up) => {
    cache.set(url, { at: Date.now(), up });
    return up;
  });
  cache.set(url, { at: hit?.at ?? 0, up: hit?.up ?? false, pending });
  return pending;
}
