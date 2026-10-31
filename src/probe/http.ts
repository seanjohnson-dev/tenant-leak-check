import { ToolError } from "../core/errors.ts";
import type { HttpEvidence } from "../core/results.ts";
import { assertLocalUrl } from "../safety/local-only.ts";

export const REQUEST_TIMEOUT_MS = 10_000;
export const EXCERPT_LIMIT = 600;

/** Who a request is sent as. `service` is used only by the tool itself for seeding and restoring files. */
export type Caller = { kind: "anon" } | { kind: "user"; accessToken: string } | { kind: "service" };

export interface ApiKeys {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON body, if the body was JSON. */
  json: unknown;
  text: string;
  /** The PostgREST / Postgres error code, if the body carried one (for example `42501`). */
  errorCode?: string;
  errorMessage?: string;
  /** Set when the request never got an answer (timeout or connection failure). */
  networkError?: string;
}

export interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path below the API URL, for example `/rest/v1/invoices?id=eq.1`. */
  path: string;
  caller: Caller;
  json?: unknown;
  /** Raw body (for file uploads). */
  raw?: { body: string; contentType: string };
  headers?: Record<string, string>;
}

/** Removes anything that looks like a key, token or password from text that goes into evidence. */
export function redact(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted token]")
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted key]")
    .replace(/("(?:access_token|refresh_token|password|apikey|api_key|token)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');
}

export function excerpt(text: string, limit = EXCERPT_LIMIT): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}… (${clean.length - limit} more characters)` : clean;
}

export class ApiClient {
  readonly #keys: ApiKeys;

  constructor(keys: ApiKeys) {
    assertLocalUrl(keys.apiUrl, "Supabase API URL");
    this.#keys = keys;
  }

  #auth(caller: Caller): Record<string, string> {
    switch (caller.kind) {
      case "anon":
        return { apikey: this.#keys.anonKey, Authorization: `Bearer ${this.#keys.anonKey}` };
      case "user":
        return { apikey: this.#keys.anonKey, Authorization: `Bearer ${caller.accessToken}` };
      case "service":
        return { apikey: this.#keys.serviceRoleKey, Authorization: `Bearer ${this.#keys.serviceRoleKey}` };
    }
  }

  async send(options: RequestOptions): Promise<HttpResponse> {
    const url = new URL(options.path, this.#keys.apiUrl);
    assertLocalUrl(url.toString(), "request URL");
    const headers: Record<string, string> = { ...this.#auth(options.caller), ...options.headers };
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.raw) {
      headers["Content-Type"] = options.raw.contentType;
      body = options.raw.body;
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: body ?? null,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (error) {
      const name = (error as Error).name;
      return {
        status: 0,
        json: undefined,
        text: "",
        networkError:
          name === "TimeoutError"
            ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`
            : `the request failed: ${(error as Error).message}`,
      };
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const result: HttpResponse = { status: response.status, json, text };
    if (json !== null && typeof json === "object" && !Array.isArray(json)) {
      const body = json as Record<string, unknown>;
      const code = body.code ?? body.error_code ?? body.statusCode;
      if (code !== undefined && code !== null) result.errorCode = String(code);
      const message = body.message ?? body.msg ?? body.error_description ?? body.error;
      if (typeof message === "string") result.errorMessage = message;
    }
    return result;
  }

  /** Same as `send`, but turns a network failure into a ToolError (used by setup steps, not by probes). */
  async sendOrFail(options: RequestOptions, what: string): Promise<HttpResponse> {
    const response = await this.send(options);
    if (response.networkError) {
      throw new ToolError(`Could not reach the local stack while ${what}: ${response.networkError}.`, "Check that the stack is still running.");
    }
    return response;
  }
}

/** Evidence for one request: method, path (no host, no keys), the synthetic body, status and a short excerpt. */
export function evidenceOf(options: RequestOptions, response: HttpResponse): HttpEvidence {
  const evidence: HttpEvidence = {
    method: options.method,
    path: redact(options.path),
    status: response.status,
    response: response.networkError ? `(no response: ${response.networkError})` : excerpt(response.text || "(empty body)"),
  };
  if (options.json !== undefined) evidence.body = options.json;
  else if (options.raw) evidence.body = `(${options.raw.contentType} file, ${options.raw.body.length} bytes)`;
  return evidence;
}
