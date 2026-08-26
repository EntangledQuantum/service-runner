import { execFile } from "node:child_process";
import { getConfig, liveRootPids, listGroups, listServices } from "./process-manager.ts";

interface ProcRow {
  id: number;
  parent: number;
  ws: number;
}

let procCache: { at: number; rows: ProcRow[] } | null = null;
let cpuSample = { at: Date.now(), cpu: process.cpuUsage(), pct: 0 };

function refreshCpu(): number {
  const now = Date.now();
  const elapsedUs = (now - cpuSample.at) * 1000;
  if (elapsedUs <= 0) return cpuSample.pct;
  const usage = process.cpuUsage(cpuSample.cpu);
  const pct = Math.min(100, ((usage.user + usage.system) / elapsedUs) * 100);
  cpuSample = { at: now, cpu: process.cpuUsage(), pct };
  return pct;
}

function parseProcs(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(",").map((s) => s.trim());
    if (parts.length < 3) continue;
    const id = Number(parts[0]);
    const parent = Number(parts[1]);
    const ws = Number(parts[2]);
    if (!id || !Number.isFinite(ws)) continue;
    rows.push({ id, parent, ws });
  }
  return rows;
}

function loadProcs(): Promise<ProcRow[]> {
  if (procCache && Date.now() - procCache.at < 2500) return Promise.resolve(procCache.rows);
  return new Promise((resolve) => {
    const child = execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize }",
      ],
      { windowsHide: true, timeout: 8000, maxBuffer: 20_000_000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(procCache?.rows ?? []);
          return;
        }
        const rows = parseProcs(stdout);
        procCache = { at: Date.now(), rows };
        resolve(rows);
      },
    );
    child.stdin?.end();
  });
}

function treeBytes(rows: ProcRow[], roots: number[]): { bytes: number; count: number } {
  const byParent = new Map<number, ProcRow[]>();
  const byId = new Map<number, ProcRow>();
  for (const r of rows) {
    byId.set(r.id, r);
    const list = byParent.get(r.parent) ?? [];
    list.push(r);
    byParent.set(r.parent, list);
  }
  const seen = new Set<number>();
  const stack = [...roots];
  let bytes = 0;
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (row) bytes += row.ws;
    for (const child of byParent.get(id) ?? []) stack.push(child.id);
  }
  return { bytes, count: seen.size };
}

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export async function collectStats() {
  const services = listServices();
  const counts = { running: 0, starting: 0, stopping: 0, stopped: 0, crashed: 0 };
  for (const s of services) counts[s.runtime.status] += 1;
  const live = counts.running + counts.starting;
  const runnerBytes = process.memoryUsage().rss;
  const roots = liveRootPids();
  const rows = await loadProcs();
  const servicesTree = treeBytes(rows, roots);
  const runnerTree = treeBytes(rows, [process.pid]);
  const cpuPct = Math.round(refreshCpu());
  return {
    running: live,
    total: services.length,
    crashed: counts.crashed,
    stopped: counts.stopped,
    starting: counts.starting,
    groups: listGroups().length,
    uptimeSec: Math.round(process.uptime()),
    port: getConfig().port,
    cpuPct,
    memory: {
      runnerMb: mb(runnerBytes),
      servicesMb: mb(servicesTree.bytes),
      totalMb: mb(runnerBytes + servicesTree.bytes),
      runnerProcs: runnerTree.count,
      serviceProcs: servicesTree.count,
    },
  };
}
