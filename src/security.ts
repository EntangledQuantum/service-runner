import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve, win32 } from "node:path";
import { bad } from "./types.ts";

export const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const DRIVE_ABS = /^[a-zA-Z]:[\\/]/;
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function assertServiceId(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw bad(
      400,
      "id must be 1–64 chars of letters, numbers, dot, underscore, or dash, and start with a letter or number",
    );
  }
  return id;
}

/**
 * Service Runner only launches programs that already live on this machine.
 * Reject URLs, UNC/network shares, and anything that is not a local drive path.
 */
export function assertLocalDir(input: unknown, field = "cwd"): string {
  if (typeof input !== "string" || !input.trim()) {
    throw bad(400, `${field} is required (absolute local Windows path)`);
  }
  const raw = input.trim();

  if (isUnc(raw)) {
    throw bad(400, `${field} cannot be a network (UNC) path. Service Runner only runs local programs.`);
  }

  if (looksLikeUrl(raw)) {
    throw bad(400, `${field} cannot be a URL. Service Runner only runs local programs.`);
  }

  if (!DRIVE_ABS.test(raw) && !isAbsolute(raw)) {
    throw bad(400, `${field} must be an absolute local path, e.g. E:\\My_Project\\app`);
  }

  const resolved = resolve(raw);

  if (isUnc(resolved) || !DRIVE_ABS.test(resolved)) {
    throw bad(400, `${field} must be on a local drive (C:\\, E:\\, …), not a share or URL.`);
  }

  if (!existsSync(resolved)) {
    throw bad(400, `${field} does not exist: ${resolved}`);
  }
  let st;
  try {
    st = statSync(resolved);
  } catch {
    throw bad(400, `${field} is not readable: ${resolved}`);
  }
  if (!st.isDirectory()) {
    throw bad(400, `${field} must be a directory: ${resolved}`);
  }
  return resolved;
}

export function assertOptionalLocalDir(input: unknown, field: string): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  return assertLocalDir(input, field);
}

export function looksLikeUrl(raw: string): boolean {
  if (DRIVE_ABS.test(raw)) return false;
  if (URL_SCHEME.test(raw)) return true;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ftp:" || u.protocol === "file:";
  } catch {
    return false;
  }
}

export function isUnc(raw: string): boolean {
  const n = raw.replace(/\//g, "\\");
  if (n.startsWith("\\\\")) return true;
  if (n.toLowerCase().startsWith("\\\\?\\unc\\")) return true;
  if (n.toLowerCase().startsWith("//")) return true;
  return win32.isAbsolute(raw) && raw.startsWith("\\\\");
}

export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === ":1" ||
    addr === "localhost" ||
    addr.endsWith("127.0.0.1")
  );
}

export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "service";
}
