import {
  type Actor,
  type CheckResult,
  type CheckSpec,
  type Evidence,
  type HttpEvidence,
  inconclusive,
  leaked,
  notTested,
  passed,
} from "../core/results.ts";
import { type BucketSeed, type Canary, encodeObjectPath, readObjects, uploadCanary } from "../seed/files.ts";
import { randomTag } from "../seed/values.ts";
import { ACTORS, actorName, callerFor, type ProbeContext } from "./common.ts";
import { evidenceOf, excerpt, type HttpResponse, type RequestOptions } from "./http.ts";

export const STORAGE_OPERATIONS = ["list", "download", "upload", "overwrite", "delete"] as const;

function specOf(bucket: string, operation: string, actor: Actor): CheckSpec {
  return { kind: "storage", target: bucket, operation, actor };
}

/** Files the actor must not reach: tenant B's for tenant A; both tenants' for an anonymous visitor. */
function readTargets(seed: BucketSeed, actor: Actor): Canary[] {
  return seed.canaries.filter((canary) => actor === "anon" || canary.tenant === "B");
}

function writeTargets(seed: BucketSeed): Canary[] {
  return seed.canaries.filter((canary) => canary.tenant === "B");
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Storage answers requests that row level security blocks with 4xx codes that look like
 * "not found", so a 4xx is only noted. The verdict comes from storage.objects (DESIGN.md 7.3).
 */
function refusalNote(response: HttpResponse): string | undefined {
  if (response.status >= 400 && response.status < 500) {
    return `The storage API refused the request (HTTP ${response.status}${response.errorMessage ? `: ${response.errorMessage}` : ""}).`;
  }
  return undefined;
}

function unclear(responses: readonly HttpResponse[]): string | undefined {
  const bad = responses.find((r) => r.networkError || r.status >= 500);
  if (!bad) return undefined;
  return bad.networkError
    ? `The storage API gave no answer (${bad.networkError}).`
    : `The storage API answered with a server error (HTTP ${bad.status}${bad.errorMessage ? `: ${bad.errorMessage}` : ""}).`;
}

async function call(ctx: ProbeContext, options: RequestOptions, log: HttpEvidence[]): Promise<HttpResponse> {
  const response = await ctx.api.send(options);
  log.push(evidenceOf(options, response));
  return response;
}

function finish(spec: CheckSpec, requests: HttpEvidence[], responses: HttpResponse[], summary: string, after: string): CheckResult {
  const evidence: Evidence = { actor: spec.actor, requests, summary, after };
  const reason = unclear(responses);
  if (reason) return inconclusive(spec, reason, evidence);
  const notes = [...new Set(responses.map(refusalNote).filter((n): n is string => n !== undefined))];
  return passed(spec, evidence, notes.slice(0, 1));
}

async function probeList(ctx: ProbeContext, seed: BucketSeed, actor: Actor): Promise<CheckResult> {
  const spec = specOf(seed.bucket.id, "list", actor);
  const requests: HttpEvidence[] = [];
  const responses: HttpResponse[] = [];
  const targets = readTargets(seed, actor);
  for (const folder of [...new Set(targets.map((t) => t.folder))]) {
    const response = await call(
      ctx,
      {
        method: "POST",
        path: `/storage/v1/object/list/${encodeURIComponent(seed.bucket.id)}`,
        caller: callerFor(ctx, actor),
        json: { prefix: folder, limit: 100, offset: 0 },
      },
      requests,
    );
    responses.push(response);
    const names = Array.isArray(response.json) ? response.json.map((item) => String((item as { name?: unknown }).name)) : [];
    const seen = targets.filter((t) => t.folder === folder && names.includes(fileName(t.path)));
    if (seen.length > 0) {
      return leaked(spec, {
        actor,
        requests,
        before: `The folder ${folder}/ holds tenant ${seen[0]?.tenant}'s test file.`,
        after: `The listing showed ${seen.map((s) => s.path).join(", ")}.`,
        summary: `${actorName(actor)} listed another tenant's files in the bucket ${seed.bucket.id}.`,
      });
    }
  }
  return finish(spec, requests, responses, `${actorName(actor)} could not list another tenant's files in ${seed.bucket.id}.`, "No other tenant's file names came back.");
}

async function probeDownload(ctx: ProbeContext, seed: BucketSeed, actor: Actor): Promise<CheckResult> {
  const spec = specOf(seed.bucket.id, "download", actor);
  const requests: HttpEvidence[] = [];
  const responses: HttpResponse[] = [];
  const allowPublic = ctx.config.storage.allowPublic.includes(seed.bucket.id);
  let publicLeak: Canary | undefined;
  for (const canary of readTargets(seed, actor)) {
    const paths = [`/storage/v1/object/authenticated/${encodeURIComponent(seed.bucket.id)}/${encodeObjectPath(canary.path)}`];
    if (seed.bucket.public) paths.push(`/storage/v1/object/public/${encodeURIComponent(seed.bucket.id)}/${encodeObjectPath(canary.path)}`);
    for (const path of paths) {
      const response = await call(ctx, { method: "GET", path, caller: callerFor(ctx, actor) }, requests);
      responses.push(response);
      if (response.status >= 200 && response.status < 300 && response.text === canary.content) {
        const viaPublic = path.includes("/object/public/");
        if (viaPublic && allowPublic) {
          publicLeak = canary;
          continue;
        }
        return leaked(spec, {
          actor,
          requests,
          before: `${canary.path} is tenant ${canary.tenant}'s test file.`,
          after: `The download returned the file's exact content: "${excerpt(response.text, 120)}".`,
          summary: viaPublic
            ? `${actorName(actor)} downloaded another tenant's file through the public link of the bucket ${seed.bucket.id}.`
            : `${actorName(actor)} downloaded another tenant's file from the bucket ${seed.bucket.id}.`,
        });
      }
    }
  }
  const result = finish(spec, requests, responses, `${actorName(actor)} could not download another tenant's files from ${seed.bucket.id}.`, "No other tenant's file content came back.");
  if (publicLeak && result.status === "pass") {
    result.notes.unshift(`Allowed public: the config lists ${seed.bucket.id} as intentionally public, so anyone with a link can download its files.`);
  }
  return result;
}

async function probeUpload(ctx: ProbeContext, seed: BucketSeed, actor: Actor): Promise<CheckResult> {
  const spec = specOf(seed.bucket.id, "upload", actor);
  const requests: HttpEvidence[] = [];
  const responses: HttpResponse[] = [];
  const contentType = seed.canaries[0]?.contentType ?? "text/plain";
  for (const folder of [...new Set(writeTargets(seed).map((t) => t.folder))]) {
    const path = `${folder ? `${folder}/` : ""}tlc-intruder-${randomTag(8)}.txt`;
    const response = await call(
      ctx,
      {
        method: "POST",
        path: `/storage/v1/object/${encodeURIComponent(seed.bucket.id)}/${encodeObjectPath(path)}`,
        caller: callerFor(ctx, actor),
        raw: { body: `tlc intruder file (${randomTag()})`, contentType },
      },
      requests,
    );
    responses.push(response);
    const objects = await readObjects(ctx.db, seed.bucket.id);
    if (objects.has(path)) {
      await ctx.api.send({
        method: "DELETE",
        path: `/storage/v1/object/${encodeURIComponent(seed.bucket.id)}/${encodeObjectPath(path)}`,
        caller: { kind: "service" },
      });
      return leaked(spec, {
        actor,
        requests,
        before: `The folder ${folder}/ belongs to tenant B.`,
        after: `storage.objects now holds ${path} (the tool removed it again).`,
        summary: `${actorName(actor)} uploaded a file into tenant B's folder in the bucket ${seed.bucket.id}.`,
      });
    }
  }
  return finish(spec, requests, responses, `${actorName(actor)} could not upload files into tenant B's folders in ${seed.bucket.id}.`, "No new file appeared in tenant B's folders.");
}

async function probeChange(ctx: ProbeContext, seed: BucketSeed, actor: Actor, operation: "overwrite" | "delete"): Promise<CheckResult> {
  const spec = specOf(seed.bucket.id, operation, actor);
  const requests: HttpEvidence[] = [];
  const responses: HttpResponse[] = [];
  for (const canary of writeTargets(seed)) {
    const before = (await readObjects(ctx.db, seed.bucket.id)).get(canary.path);
    if (!before) return inconclusive(spec, `Tenant B's test file ${canary.path} was missing before the attempt.`);
    const objectPath = `/storage/v1/object/${encodeURIComponent(seed.bucket.id)}/${encodeObjectPath(canary.path)}`;
    const response = await call(
      ctx,
      operation === "overwrite"
        ? { method: "PUT", path: objectPath, caller: callerFor(ctx, actor), raw: { body: `tlc overwritten (${randomTag()})`, contentType: canary.contentType } }
        : { method: "DELETE", path: objectPath, caller: callerFor(ctx, actor) },
      requests,
    );
    responses.push(response);
    const after = (await readObjects(ctx.db, seed.bucket.id)).get(canary.path);
    const changed = operation === "delete" ? after === undefined : after === undefined || after.fingerprint !== before.fingerprint;
    if (changed) {
      const restoreError = await uploadCanary(ctx.api, canary);
      if (restoreError) throw new Error(`could not restore the test file ${canary.path}: ${restoreError}`);
      return leaked(spec, {
        actor,
        requests,
        before: `${canary.path} is tenant B's test file.`,
        after:
          operation === "delete"
            ? "The file is gone from storage.objects (the tool put it back)."
            : "The stored file changed (new version in storage.objects; the tool put the original back).",
        summary:
          operation === "delete"
            ? `${actorName(actor)} deleted tenant B's file in the bucket ${seed.bucket.id}.`
            : `${actorName(actor)} replaced tenant B's file in the bucket ${seed.bucket.id}.`,
      });
    }
  }
  return finish(
    spec,
    requests,
    responses,
    `${actorName(actor)} could not ${operation === "delete" ? "delete" : "replace"} tenant B's files in ${seed.bucket.id}.`,
    "Tenant B's files are unchanged in storage.objects.",
  );
}

/** Runs the storage probes of DESIGN.md section 7.3 on one bucket, as tenant A and as an anonymous visitor. */
export async function probeBucket(ctx: ProbeContext, seed: BucketSeed): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  for (const actor of ACTORS) {
    for (const operation of STORAGE_OPERATIONS) {
      const spec = specOf(seed.bucket.id, operation, actor);
      if (seed.failure) {
        checks.push(notTested(spec, "could_not_test", `The tool ${seed.failure}.`));
        continue;
      }
      if (writeTargets(seed).length === 0) {
        checks.push(notTested(spec, "could_not_test", "No test file for tenant B could be placed in this bucket."));
        continue;
      }
      if (operation === "list") checks.push(await probeList(ctx, seed, actor));
      else if (operation === "download") checks.push(await probeDownload(ctx, seed, actor));
      else if (operation === "upload") checks.push(await probeUpload(ctx, seed, actor));
      else checks.push(await probeChange(ctx, seed, actor, operation));
    }
  }
  return checks;
}
