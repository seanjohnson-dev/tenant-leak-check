import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolError } from "../../src/core/errors.ts";
import { assertLocalUrl, describeUrlSafely, isLocalUrl } from "../../src/safety/local-only.ts";

describe("isLocalUrl", () => {
  const local = [
    "http://127.0.0.1:54321",
    "http://127.0.0.1:55421/rest/v1",
    "http://localhost:54321",
    "http://LOCALHOST:54321",
    "https://127.0.0.1",
    "http://127.1.2.3:80",
    "http://[::1]:54321",
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgres://postgres@localhost:5432/postgres",
  ];
  for (const url of local) {
    it(`accepts ${url}`, () => assert.equal(isLocalUrl(url), true));
  }

  const notLocal = [
    "https://abcdefghijklmno.supabase.co",
    "https://db.abcdefghijklmno.supabase.co:5432",
    "postgresql://postgres:secret@db.example.com:5432/postgres",
    "http://0.0.0.0:54321",
    "http://10.0.0.5:54321",
    "http://192.168.1.10:54321",
    "http://localhost.example.com",
    "http://127.0.0.1.example.com",
    "http://example.com/?next=http://127.0.0.1",
    "http://127.0.0.1@example.com",
    "http://[::ffff:127.0.0.1]",
    "postgresql://127.0.0.1.nip.io/postgres",
    "ftp://127.0.0.1",
    "file:///tmp/socket",
    "127.0.0.1:54321",
    "",
    "not a url",
  ];
  for (const url of notLocal) {
    it(`rejects ${JSON.stringify(url)}`, () => assert.equal(isLocalUrl(url), false));
  }
});

describe("assertLocalUrl", () => {
  it("returns the parsed URL for a local address", () => {
    assert.equal(assertLocalUrl("http://127.0.0.1:55421", "Supabase API URL").port, "55421");
  });

  it("throws a ToolError that names the URL and explains the rule", () => {
    assert.throws(
      () => assertLocalUrl("https://abcdefghijklmno.supabase.co", "Supabase API URL"),
      (error: unknown) =>
        error instanceof ToolError &&
        error.message.includes("Supabase API URL") &&
        error.message.includes("https://abcdefghijklmno.supabase.co") &&
        (error.hint ?? "").includes("local Supabase stack"),
    );
  });

  it("never echoes credentials from a refused URL", () => {
    assert.throws(
      () => assertLocalUrl("postgresql://postgres:hunter2-secret@db.example.com:5432/postgres", "database URL"),
      (error: unknown) =>
        error instanceof ToolError &&
        !error.message.includes("hunter2-secret") &&
        !(error.hint ?? "").includes("hunter2-secret"),
    );
  });
});

describe("describeUrlSafely", () => {
  it("keeps only protocol, host and port", () => {
    assert.equal(describeUrlSafely("postgresql://user:pw@db.example.com:5432/postgres?sslmode=require"), "postgresql://db.example.com:5432");
  });

  it("handles invalid input", () => {
    assert.equal(describeUrlSafely("::::"), "(not a valid URL)");
  });
});
