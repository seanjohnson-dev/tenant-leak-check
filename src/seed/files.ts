import type { ToolConfig } from "../config/config.ts";
import type { Bucket } from "../discover/catalog.ts";
import type { ApiClient } from "../probe/http.ts";
import type { Database } from "../stack/db.ts";
import type { Tenant } from "./rows.ts";
import { randomTag } from "./values.ts";

export const DEFAULT_PATH_TEMPLATES = ["{tenant}/{file}", "{user}/{file}"] as const;

export interface Canary {
  bucket: string;
  tenant: "A" | "B";
  /** Object path inside the bucket, for example `<org id>/tlc-canary-b-k3f9q2.txt`. */
  path: string;
  /** The folder part of `path` (everything before the file name). */
  folder: string;
  content: string;
  contentType: string;
}

export interface BucketSeed {
  bucket: Bucket;
  canaries: Canary[];
  failure?: string;
}

export interface ObjectState {
  id: string;
  fingerprint: string;
}

/** Builds object paths from the templates. Templates that need a tenant id are skipped when there is none. */
export function canaryPaths(templates: readonly string[], tenant: Tenant, hasTenantIds: boolean, file: string): string[] {
  const paths: string[] = [];
  for (const template of templates) {
    if (template.includes("{tenant}") && !hasTenantIds) continue;
    paths.push(
      template.replaceAll("{tenant}", String(tenant.tenantId)).replaceAll("{user}", tenant.user.id).replaceAll("{file}", file),
    );
  }
  return [...new Set(paths)];
}

/** A content type the bucket accepts: text/plain if allowed, otherwise the first allowed type. */
export function pickContentType(allowed: readonly string[]): string {
  if (allowed.length === 0) return "text/plain";
  const accepts = (type: string): boolean =>
    allowed.some((rule) => rule === type || rule === "*/*" || (rule.endsWith("/*") && type.startsWith(rule.slice(0, -1))));
  if (accepts("text/plain")) return "text/plain";
  const first = allowed[0] as string;
  return first.endsWith("/*") ? `${first.slice(0, -2)}/${first.startsWith("image") ? "png" : "octet-stream"}` : first;
}

export function encodeObjectPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Uploads (or re-uploads) a canary with the service key, which the tool uses only for seeding and restoring. */
export async function uploadCanary(api: ApiClient, canary: Canary): Promise<string | undefined> {
  const response = await api.send({
    method: "POST",
    path: `/storage/v1/object/${encodeURIComponent(canary.bucket)}/${encodeObjectPath(canary.path)}`,
    caller: { kind: "service" },
    raw: { body: canary.content, contentType: canary.contentType },
    headers: { "x-upsert": "true" },
  });
  if (response.networkError) return response.networkError;
  if (response.status >= 300) return `${response.errorMessage ?? "upload refused"} (HTTP ${response.status})`;
  return undefined;
}

/** Uploads one canary file per tenant and folder convention in every bucket (DESIGN.md section 7.1). */
export async function seedFiles(
  api: ApiClient,
  buckets: readonly Bucket[],
  tenants: { A: Tenant; B: Tenant },
  hasTenantIds: boolean,
  config: ToolConfig,
): Promise<BucketSeed[]> {
  const templates = config.storage.pathTemplates ?? [...DEFAULT_PATH_TEMPLATES];
  const seeds: BucketSeed[] = [];
  for (const bucket of buckets) {
    const seed: BucketSeed = { bucket, canaries: [] };
    const contentType = pickContentType(bucket.allowedMimeTypes);
    for (const tenant of [tenants.A, tenants.B]) {
      const tag = randomTag(8);
      const file = `tlc-canary-${tenant.label.toLowerCase()}-${tag}.txt`;
      for (const path of canaryPaths(templates, tenant, hasTenantIds, file)) {
        const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const canary: Canary = {
          bucket: bucket.id,
          tenant: tenant.label,
          path,
          folder,
          content: `tlc canary file of tenant ${tenant.label} in bucket ${bucket.id} (${tag}${randomTag(4)})`,
          contentType,
        };
        const error = await uploadCanary(api, canary);
        if (error) {
          seed.failure = `could not upload test files because: ${error}`;
          break;
        }
        seed.canaries.push(canary);
      }
      if (seed.failure) break;
    }
    if (seed.failure) seed.canaries = [];
    seeds.push(seed);
  }
  return seeds;
}

/** The state of every object in a bucket, read from storage.objects, used to see whether a probe changed anything. */
export async function readObjects(db: Database, bucket: string): Promise<Map<string, ObjectState>> {
  const rows = await db.query<{ name: string; id: string; fingerprint: string }>(
    `select name, id::text as id,
            concat_ws('|', id::text, coalesce(version, ''), coalesce(metadata->>'eTag', ''), coalesce(updated_at::text, '')) as fingerprint
     from storage.objects where bucket_id = $1`,
    [bucket],
  );
  return new Map(rows.map((row) => [row.name, { id: row.id, fingerprint: row.fingerprint }]));
}
