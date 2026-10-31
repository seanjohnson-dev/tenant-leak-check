import { ToolError } from "../core/errors.ts";

const LOOPBACK_NAMES = new Set(["localhost", "[::1]"]);
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "postgres:", "postgresql:"]);

/** True for 127.0.0.0/8 written as a plain dotted IPv4 address. */
function isIPv4Loopback(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * True only if `raw` is a URL whose host is this machine's loopback interface.
 * Anything unusual (unparseable, other protocols, 0.0.0.0, look-alike names) is treated as not local.
 */
export function isLocalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  return LOOPBACK_NAMES.has(host) || isIPv4Loopback(host);
}

/** Describes a URL without any credentials, path or query, so it is safe to print. */
export function describeUrlSafely(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "(not a valid URL)";
  }
}

/**
 * Stops the run unless `raw` points at this machine. `what` names the URL for
 * the error message, for example "Supabase API URL".
 */
export function assertLocalUrl(raw: string, what: string): URL {
  if (!isLocalUrl(raw)) {
    throw new ToolError(
      `Refusing to connect: the ${what} (${describeUrlSafely(raw)}) is not on this machine.`,
      "tenant-leak-check only runs against a local Supabase stack started with the Supabase CLI " +
        "(127.0.0.1 or localhost). It never connects to hosted or production projects.",
    );
  }
  return new URL(raw);
}
