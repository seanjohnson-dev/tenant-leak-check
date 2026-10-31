import { randomBytes } from "node:crypto";
import { SetupProblem } from "../core/errors.ts";
import type { ApiClient } from "../probe/http.ts";

export interface TestUser {
  label: "A" | "B";
  id: string;
  email: string;
  /** Held in memory only, never printed. */
  accessToken: string;
}

export const TEST_EMAILS = { A: "tlc-tenant-a@example.com", B: "tlc-tenant-b@example.com" } as const;

function describeAuthError(status: number, body: unknown): string {
  const record = (body ?? {}) as Record<string, unknown>;
  const message = record.msg ?? record.message ?? record.error_description ?? record.error;
  return `${typeof message === "string" ? message : "no message"} (HTTP ${status})`;
}

/**
 * Creates a confirmed user through the Auth admin API (so sign-up triggers run exactly
 * as in the app), then signs in with the normal password flow (DESIGN.md section 7.1).
 */
export async function createTestUser(api: ApiClient, label: "A" | "B"): Promise<TestUser> {
  const email = TEST_EMAILS[label];
  const password = `${randomBytes(18).toString("base64url")}aA1!`;
  const created = await api.sendOrFail(
    {
      method: "POST",
      path: "/auth/v1/admin/users",
      caller: { kind: "service" },
      json: { email, password, email_confirm: true, user_metadata: { full_name: `TLC Tenant ${label}` } },
    },
    `creating test user ${label}`,
  );
  const user = created.json as { id?: unknown } | undefined;
  if (created.status >= 300 || typeof user?.id !== "string") {
    throw new SetupProblem(
      `The local Auth service refused to create test user ${label}: ${describeAuthError(created.status, created.json)}.`,
      "A sign-up trigger in the migrations may be failing for new users. Check the trigger on auth.users.",
    );
  }
  const session = await api.sendOrFail(
    {
      method: "POST",
      path: "/auth/v1/token?grant_type=password",
      caller: { kind: "anon" },
      json: { email, password },
    },
    `signing in test user ${label}`,
  );
  const token = (session.json as { access_token?: unknown } | undefined)?.access_token;
  if (session.status >= 300 || typeof token !== "string") {
    throw new SetupProblem(
      `Test user ${label} could not sign in: ${describeAuthError(session.status, session.json)}.`,
      "The local Auth settings may block password sign-in.",
    );
  }
  return { label, id: user.id, email, accessToken: token };
}
