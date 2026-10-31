import type { ToolConfig } from "../config/config.ts";
import type { Actor } from "../core/results.ts";
import type { Catalog } from "../discover/catalog.ts";
import type { TenancyModel } from "../discover/tenancy.ts";
import type { SeedResult } from "../seed/rows.ts";
import type { TestUser } from "../seed/users.ts";
import type { World } from "../seed/world.ts";
import type { Database } from "../stack/db.ts";
import type { ApiClient, Caller, HttpResponse } from "./http.ts";

export interface ProbeContext {
  db: Database;
  api: ApiClient;
  catalog: Catalog;
  tenancy: TenancyModel;
  config: ToolConfig;
  seed: SeedResult;
  world: World;
  userA: TestUser;
}

export const ACTORS: readonly Actor[] = ["tenant_a", "anon"];

export function callerFor(ctx: ProbeContext, actor: Actor): Caller {
  return actor === "tenant_a" ? { kind: "user", accessToken: ctx.userA.accessToken } : { kind: "anon" };
}

/** Data the actor must not see: tenant B's for tenant A; both tenants' for an anonymous visitor. */
export function foreignMarkers(ctx: ProbeContext, actor: Actor): Set<string> {
  return actor === "tenant_a" ? ctx.seed.markers.B : new Set([...ctx.seed.markers.A, ...ctx.seed.markers.B]);
}

export function actorName(actor: Actor): string {
  return actor === "tenant_a" ? "Tenant A" : "An anonymous visitor";
}

/** The markers that appear in `text`, longest first, at most `limit`. */
export function findMarkers(text: string, markers: ReadonlySet<string>, limit = 5): string[] {
  const found: string[] = [];
  for (const marker of [...markers].sort((a, b) => b.length - a.length)) {
    if (text.includes(marker) && !found.some((f) => f.includes(marker))) found.push(marker);
    if (found.length >= limit) break;
  }
  return found;
}

/** For a JSON array response: the first element that contains one of the markers, as JSON text. */
export function firstLeakedItem(response: HttpResponse, markers: readonly string[]): string | undefined {
  const items = Array.isArray(response.json) ? response.json : response.json === undefined ? [] : [response.json];
  for (const item of items) {
    const text = JSON.stringify(item);
    if (markers.some((marker) => text.includes(marker))) return text;
  }
  return undefined;
}

export type Outcome =
  | { kind: "ok" }
  | { kind: "denied"; note: string }
  | { kind: "error"; reason: string }
  | { kind: "server_error"; reason: string };

/** How an API answer should be read. The verdict itself still comes from the database. */
export function classifyResponse(response: HttpResponse): Outcome {
  if (response.networkError) return { kind: "server_error", reason: `The API gave no answer (${response.networkError}).` };
  if (response.status >= 200 && response.status < 300) return { kind: "ok" };
  const message = response.errorMessage ?? "";
  if (response.errorCode === "42501" || response.status === 401 || response.status === 403) {
    return {
      kind: "denied",
      note: /row-level security/i.test(message) ? "Blocked by row level security." : "Blocked by permissions.",
    };
  }
  if (response.status >= 500) {
    return { kind: "server_error", reason: `The API answered with a server error (HTTP ${response.status}${message ? `: ${message}` : ""}).` };
  }
  return {
    kind: "error",
    reason: `The API rejected the request for a reason other than access rules (HTTP ${response.status}${
      response.errorCode ? `, code ${response.errorCode}` : ""
    }${message ? `: ${message}` : ""}), so this test could not tell whether access would have been allowed.`,
  };
}

/** Path and headers for a PostgREST resource in any exposed schema. */
export function restTarget(schema: string, name: string, query: string, write: boolean): { path: string; headers: Record<string, string> } {
  const header = write ? "Content-Profile" : "Accept-Profile";
  return { path: `/rest/v1/${encodeURIComponent(name)}${query ? `?${query}` : ""}`, headers: { [header]: schema } };
}
