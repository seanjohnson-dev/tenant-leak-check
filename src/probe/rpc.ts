import { type Actor, type CheckResult, type CheckSpec, type Evidence, inconclusive, leaked, notTested, passed } from "../core/results.ts";
import type { FunctionArg, FunctionInfo } from "../discover/catalog.ts";
import { primaryKey, TENANT_COLUMN_NAMES, USER_COLUMN_NAMES } from "../discover/tenancy.ts";
import { ownerOf, resolvePlaceholder, rowsOf } from "../seed/rows.ts";
import { randomTag } from "../seed/values.ts";
import { ACTORS, actorName, callerFor, findMarkers, foreignMarkers, type ProbeContext } from "./common.ts";
import { evidenceOf, excerpt } from "./http.ts";

/** Types PostgREST accepts as a single unnamed argument (the raw request body). */
const RAW_BODY_TYPES = new Set(["json", "jsonb", "text", "bytea", "xml"]);

export function normalizeArgName(name: string): string {
  return name.toLowerCase().replace(/^(p_|in_|arg_|v_|_+)/, "");
}

function singular(word: string): string[] {
  return [word, `${word}s`, `${word}es`, word.endsWith("y") ? `${word.slice(0, -1)}ies` : word];
}

/** The table a `<name>_id` (or bare `id`) argument most likely points at. */
export function tableForArg(ctx: ProbeContext, fn: FunctionInfo, arg: string): string | undefined {
  const tables = ctx.catalog.relations.filter((r) => ctx.tenancy.tables.has(r.qualified));
  const byShortName = (word: string): string | undefined =>
    singular(word)
      .map((candidate) => tables.find((t) => t.name === candidate && t.schema === fn.schema) ?? tables.find((t) => t.name === candidate))
      .find((t) => t !== undefined)?.qualified;
  if (arg.endsWith("_id")) return byShortName(arg.slice(0, -3));
  if (arg === "id") {
    for (const word of fn.name.split("_").reverse()) {
      const found = byShortName(word);
      if (found) return found;
    }
  }
  return undefined;
}

type ArgValue = { ok: true; value: unknown } | { ok: false; reason: string } | { ok: true; omit: true };

/** Fills one argument by its name and type (DESIGN.md section 7.4). */
export function fillArg(ctx: ProbeContext, fn: FunctionInfo, arg: FunctionArg): ArgValue {
  const name = normalizeArgName(arg.name);
  const B = ctx.seed.tenants.B;
  const base = arg.type.base;
  const isText = arg.type.category === "S";
  if ((TENANT_COLUMN_NAMES as readonly string[]).includes(name) || name === "tenant" || name === "org" || name === "organization") {
    return { ok: true, value: isText ? String(B.tenantId) : B.tenantId };
  }
  if ((USER_COLUMN_NAMES as readonly string[]).includes(name) || name === "uid" || name === "user") return { ok: true, value: B.user.id };
  if (name === "id" || name.endsWith("_id")) {
    const table = tableForArg(ctx, fn, name);
    const relation = table ? ctx.catalog.relations.find((r) => r.qualified === table) : undefined;
    const row = table ? rowsOf(ctx.seed, table, "B")[0] : undefined;
    const pk = relation ? primaryKey(relation) : [];
    if (row && pk.length === 1 && pk[0]) return { ok: true, value: row.data[pk[0]] };
  }
  if (arg.hasDefault) return { ok: true, omit: true };
  if (base === "uuid") return { ok: true, value: B.tenantId };
  if (arg.type.category === "A") return { ok: true, value: [] };
  if (arg.type.category === "E") return { ok: true, value: arg.type.enumLabels[0] };
  if (isText) return { ok: true, value: `tlc-B-rpc-${randomTag()}` };
  if (arg.type.category === "N") return { ok: true, value: 1 };
  if (base === "bool") return { ok: true, value: true };
  if (base === "json" || base === "jsonb") return { ok: true, value: {} };
  if (base === "date") return { ok: true, value: new Date().toISOString().slice(0, 10) };
  if (base === "timestamptz" || base === "timestamp") return { ok: true, value: new Date().toISOString() };
  return { ok: false, reason: `its argument ${arg.name} has the type ${arg.type.display}, which the tool cannot fill in` };
}

function specOf(fn: FunctionInfo, actor: Actor): CheckSpec {
  return { kind: "rpc", target: fn.qualified, operation: "execute", actor };
}

/** The functions clients can call: executable by anon or authenticated in an exposed schema. */
export function clientCallable(functions: readonly FunctionInfo[]): FunctionInfo[] {
  return functions.filter((fn) => fn.executable.anon || fn.executable.authenticated);
}

/** Calls one function as tenant A and as an anonymous visitor and looks for read and write leaks. */
export async function probeFunction(ctx: ProbeContext, fn: FunctionInfo): Promise<CheckResult[]> {
  const skip = ctx.config.rpc.skip[fn.qualified];
  if (skip) return ACTORS.map((actor) => notTested(specOf(fn, actor), "excluded", `Excluded in the config: ${skip}`));
  const configured = ctx.config.rpc.args[fn.qualified];
  let body: Record<string, unknown> | undefined;
  let raw: { body: string; contentType: string } | undefined;
  if (configured) {
    body = Object.fromEntries(Object.entries(configured).map(([name, value]) => [name, resolvePlaceholder(value, ctx.seed, ctx.catalog)]));
  } else if (fn.overloaded) {
    const reason = "Several functions share this name, so the tool cannot tell which one the API would call. Give its arguments in the config (rpc.args).";
    return ACTORS.map((actor) => notTested(specOf(fn, actor), "could_not_test", reason));
  } else if (fn.hasUnnamedArgs) {
    const only = fn.args[0];
    if (fn.args.length !== 1 || !only || !RAW_BODY_TYPES.has(only.type.base)) {
      const reason = "Its arguments have no names, so the Supabase API cannot call it.";
      return ACTORS.map((actor) => notTested(specOf(fn, actor), "not_applicable", reason));
    }
    const value = only.type.base.startsWith("json") ? JSON.stringify({ tenant_id: ctx.seed.tenants.B.tenantId }) : `tlc-B-rpc-${randomTag()}`;
    raw = { body: value, contentType: only.type.base.startsWith("json") ? "application/json" : "text/plain" };
  } else {
    body = {};
    for (const arg of fn.args) {
      const filled = fillArg(ctx, fn, arg);
      if (!filled.ok) {
        return ACTORS.map((actor) => notTested(specOf(fn, actor), "could_not_test", `The tool could not call this function because ${filled.reason}.`));
      }
      if (!("omit" in filled)) body[arg.name] = filled.value;
    }
  }
  const sent = new Set<string>();
  for (const value of Object.values(body ?? {})) if (typeof value === "string") sent.add(value);
  const checks: CheckResult[] = [];
  for (const actor of ACTORS) {
    const spec = specOf(fn, actor);
    const options = {
      method: "POST" as const,
      path: `/rest/v1/rpc/${encodeURIComponent(fn.name)}`,
      headers: { "Content-Profile": fn.schema },
      caller: callerFor(ctx, actor),
      ...(raw ? { raw } : { json: body ?? {} }),
    };
    const response = await ctx.api.send(options);
    const request = evidenceOf(options, response);
    const after = await ctx.world.read();
    const diffs = ctx.world.diff(after);
    await ctx.world.restore();
    const victims = actor === "anon" ? new Set(["A", "B"]) : new Set(["B"]);
    const touched: string[] = [];
    for (const diff of diffs) {
      const ownership = ctx.tenancy.tables.get(diff.table)?.ownership;
      if (!ownership) continue;
      const owned = (data: Record<string, unknown>): boolean => victims.has(ownerOf(ownership, data, ctx.seed) ?? "");
      const changed = diff.changed.filter((c) => c.before.json !== c.after.json && owned(c.before.data)).length;
      const missing = diff.missing.filter((m) => owned(m.data)).length;
      const added = diff.added.filter((a) => owned(a.data)).length;
      if (changed + missing + added > 0) {
        const parts = [missing ? `${missing} deleted` : "", changed ? `${changed} changed` : "", added ? `${added} added` : ""].filter(Boolean);
        touched.push(`${diff.table}: ${parts.join(", ")}`);
      }
    }
    const markers = new Set([...foreignMarkers(ctx, actor)].filter((marker) => !sent.has(marker)));
    const ok = response.status >= 200 && response.status < 300;
    const found = ok ? findMarkers(response.text, markers) : [];
    const evidence: Evidence = {
      actor,
      requests: [request],
      before: `The call passed tenant B's identifiers: ${excerpt(JSON.stringify(body ?? raw?.body ?? {}), 200)}.`,
      summary: "",
    };
    if (touched.length > 0 || found.length > 0) {
      const what = [found.length > 0 ? "returned another tenant's data" : "", touched.length > 0 ? "changed another tenant's data" : ""].filter(Boolean).join(" and ");
      evidence.after = [
        found.length > 0 ? `The response contained: ${excerpt(response.text, 300)}` : "",
        touched.length > 0 ? `Rows of another tenant were affected (the tool restored them): ${touched.join("; ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
      evidence.summary = `${actorName(actor)} called ${fn.qualified} and it ${what}.`;
      checks.push(leaked(spec, evidence, fn.securityDefiner ? ["The function runs as its owner (SECURITY DEFINER), so row level security does not apply inside it."] : []));
      continue;
    }
    evidence.after = "No other tenant's data came back, and the database shows no other tenant's rows changed.";
    evidence.summary = `${actorName(actor)} called ${fn.qualified} without reaching another tenant's data.`;
    if (response.networkError || response.status >= 500) {
      checks.push(inconclusive(spec, response.networkError ? `The API gave no answer (${response.networkError}).` : `The function failed with a server error (HTTP ${response.status}).`, evidence));
    } else if (!ok && response.errorCode?.startsWith("PGRST")) {
      checks.push(
        inconclusive(spec, `The API could not run the function (${response.errorCode}${response.errorMessage ? `: ${response.errorMessage}` : ""}).`, evidence),
      );
    } else if (!ok) {
      const denied = response.errorCode === "42501" || response.status === 401 || response.status === 403;
      checks.push(passed(spec, evidence, [denied ? "Blocked by permissions." : `The function refused the call: ${response.errorMessage ?? `HTTP ${response.status}`}.`]));
    } else {
      checks.push(passed(spec, evidence));
    }
  }
  return checks;
}
