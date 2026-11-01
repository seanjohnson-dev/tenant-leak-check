import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { helpText, main, toolVersion, type Output } from "../../src/cli.ts";
import { DISCLAIMER_FULL, DISCLAIMER_SHORT } from "../../src/core/disclaimer.ts";
import { EXIT } from "../../src/core/exit-codes.ts";

function capture(): Output & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (text) => stdout.push(text), err: (text) => stderr.push(text) };
}

describe("cli", () => {
  it("prints help with every exit code and the disclaimer", async () => {
    const io = capture();
    assert.equal(await main(["--help"], io), EXIT.clean);
    const text = io.stdout.join("\n");
    for (const code of Object.values(EXIT)) assert.match(text, new RegExp(`^  ${code}  `, "m"));
    assert.ok(text.includes(DISCLAIMER_SHORT));
    assert.equal(text, helpText());
  });

  it("prints help when run without a command", async () => {
    const io = capture();
    assert.equal(await main([], io), EXIT.clean);
    assert.match(io.stdout.join("\n"), /Usage:/);
  });

  it("prints the package version", async () => {
    const io = capture();
    assert.equal(await main(["--version"], io), EXIT.clean);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    assert.deepEqual(io.stdout, [pkg.version]);
    assert.equal(toolVersion(), pkg.version);
  });

  it("rejects unknown commands with exit code 3 and a hint", async () => {
    const io = capture();
    assert.equal(await main(["deploy"], io), EXIT.toolError);
    assert.match(io.stderr.join("\n"), /Unknown command "deploy"/);
    assert.match(io.stderr.join("\n"), /--help/);
  });

  it("rejects unknown options with exit code 3", async () => {
    const io = capture();
    assert.equal(await main(["doctor", "--prod"], io), EXIT.toolError);
    assert.match(io.stderr.join("\n"), /--prod/);
  });

  it("documents run, diff and the report options in the help", () => {
    const text = helpText();
    for (const part of ["run --project", "diff --project <folder> --migration <file.sql>", "--out <folder>", "report.html, report.md and report.json", "doctor"]) {
      assert.ok(text.includes(part), `${part} missing from the help`);
    }
  });

  it("diff explains missing or wrong input with exit code 3, before starting anything", async () => {
    const demo = fileURLToPath(new URL("../../demo/fixed", import.meta.url));
    const cases: [string[], RegExp][] = [
      [["diff", "--migration", "x.sql"], /Missing --project/],
      [["diff", "--project", demo], /Missing --migration/],
      [["diff", "--project", demo, "--migration", "/nonexistent/20261101000000_x.sql"], /does not exist/],
      [["diff", "--project", demo, "--migration", fileURLToPath(new URL("../../demo/migrations/README.md", import.meta.url))], /not named like a Supabase migration/],
      [["diff", "--project", demo, "--migration", fileURLToPath(new URL("../../demo/fixed/supabase/migrations/20261031000001_schema.sql", import.meta.url))], /would run before/],
      [["run", "--project", demo, "--format", "pdf"], /--format/],
    ];
    for (const [args, message] of cases) {
      const io = capture();
      assert.equal(await main(args, io), EXIT.toolError, args.join(" "));
      assert.match(io.stderr.join("\n"), message);
    }
  });

  it("runs as a real process and returns the exit code", () => {
    const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
    const output = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
    assert.equal(output.trim(), toolVersion());
    assert.throws(
      () => execFileSync(process.execPath, [cli, "nope"], { stdio: "pipe" }),
      (error: unknown) => (error as { status?: number }).status === EXIT.toolError,
    );
  });
});

describe("disclaimer", () => {
  it("states plainly that this is not a certification", () => {
    assert.match(DISCLAIMER_SHORT, /not a security certification/);
    assert.ok(DISCLAIMER_FULL.startsWith(DISCLAIMER_SHORT));
    assert.match(DISCLAIMER_FULL, /synthetic data/);
  });
});
