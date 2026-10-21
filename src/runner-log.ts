import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { format } from "node:util";

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Send console output to a file. The hidden tray process has no console, so without
 * this a crash leaves no trace at all. Keeps one previous file (`.1`) on rotation.
 */
export function logConsoleToFile(file: string): void {
  const write = (level: string, args: unknown[]) => {
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file + ".1");
      appendFileSync(file, `${new Date().toISOString()} [${level}] ${format(...args)}\n`, "utf8");
    } catch {
      /* logging must never be the thing that crashes the supervisor */
    }
  };
  console.log = (...a: unknown[]) => write("info", a);
  console.info = console.log;
  console.warn = (...a: unknown[]) => write("warn", a);
  console.error = (...a: unknown[]) => write("error", a);
}

/**
 * A supervisor that dies takes every app it runs down with it (their output pipes
 * break), so an unexpected error is logged and survived instead of exiting.
 */
export function surviveUnexpectedErrors(): void {
  process.on("uncaughtException", (err) => {
    console.error("Unexpected error (Service Runner kept running):", err instanceof Error ? err.stack : err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection (Service Runner kept running):", reason instanceof Error ? reason.stack : reason);
  });
}
