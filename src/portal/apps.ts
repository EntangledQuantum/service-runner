import { probeCached } from "../probe.ts";
import type { AppConfig, PublishConfig, ServiceConfig } from "../types.ts";
import type { RouteApp } from "./routing.ts";

export interface PortalApp {
  id: string;
  name: string;
  path: string; // "/atlas/"
  description: string;
  icon: string;
  color: string;
  status: "up" | "down";
}

type Published = ServiceConfig & { publish: PublishConfig };

/** Enabled services with a publish block, in tile order. */
export function publishedServices(cfg: AppConfig): Published[] {
  return cfg.services
    .filter((s): s is Published => Boolean(s.publish) && s.enabled !== false)
    .sort(
      (a, b) =>
        (a.publish.order ?? 100) - (b.publish.order ?? 100) ||
        (a.publish.title ?? a.name).localeCompare(b.publish.title ?? b.name),
    );
}

export function routeApps(cfg: AppConfig): RouteApp[] {
  return publishedServices(cfg).map((s) => ({
    id: s.id,
    name: s.publish.title ?? s.name,
    path: s.publish.path,
    upstream: s.publish.upstream,
    stripPrefix: s.publish.stripPrefix,
    bypass: s.publish.bypass ?? [],
    rootAliases: s.publish.rootAliases ?? [],
  }));
}

/** Emoji and http(s) URLs pass through; anything path-like is resolved under the app's public path. */
export function resolveIcon(icon: string | undefined, path: string): string {
  if (!icon) return "";
  if (icon.includes(":") || !/[/.]/.test(icon)) return icon;
  if (icon.startsWith(path + "/")) return icon;
  return `${path}/${icon.replace(/^\/+/, "")}`;
}

export async function portalApps(cfg: AppConfig): Promise<PortalApp[]> {
  const list = publishedServices(cfg);
  const up = await Promise.all(list.map((s) => probeCached(s.publish.upstream)));
  return list.map((s, i) => ({
    id: s.id,
    name: s.publish.title ?? s.name,
    path: s.publish.path + "/",
    description: s.publish.description ?? "",
    icon: resolveIcon(s.publish.icon, s.publish.path),
    color: s.publish.color ?? "",
    status: up[i] ? "up" : "down",
  }));
}
