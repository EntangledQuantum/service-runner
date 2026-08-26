import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { serviceLogsDir, logsDir } from "./paths.ts";
import { bus } from "./events.ts";
import type { AppConfig } from "./types.ts";

const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export function todayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function logFile(serviceId: string, date = todayStamp()): string {
  return join(serviceLogsDir(serviceId), `${date}.log`);
}

export function appendLog(
  serviceId: string,
  stream: "stdout" | "stderr" | "sys",
  line: string,
): string {
  const ts = new Date().toISOString();
  const clean = stripAnsi(line).replace(/\r/g, "");
  if (!clean.length) return ts;
  const formatted = `${ts} [${stream}] ${clean}\n`;
  const file = logFile(serviceId);
  mkdirSync(serviceLogsDir(serviceId), { recursive: true });
  appendFileSync(file, formatted, "utf8");
  bus.emitEvent({ type: "log", serviceId, stream, line: clean, ts });
  return ts;
}

export function readLogTail(serviceId: string, date?: string, maxLines = 400): string {
  const file = logFile(serviceId, date ?? todayStamp());
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  if (maxLines <= 0) return text;
  const lines = text.split(/\n/);
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
}

export function listLogDates(serviceId: string): string[] {
  const dir = serviceLogsDir(serviceId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort()
    .reverse();
}

export function pruneLogs(cfg: AppConfig): number {
  const cutoff = Date.now() - cfg.logRetentionDays * 24 * 60 * 60 * 1000;
  const root = logsDir();
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m) continue;
      const day = Date.parse(m[1] + "T00:00:00Z");
      if (Number.isNaN(day) || day >= cutoff) continue;
      try {
        unlinkSync(join(dir, f));
        removed++;
      } catch {
        /* ignore locked files */
      }
    }
  }
  return removed;
}

export class LineBuffer {
  private buf = "";
  constructor(private onLine: (line: string) => void) {}
  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.buf = this.buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.length) this.onLine(line);
    }
    if (this.buf.length > 64_000) {
      this.onLine(this.buf);
      this.buf = "";
    }
  }
  flush(): void {
    if (this.buf.length) {
      this.onLine(this.buf);
      this.buf = "";
    }
  }
}
