#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { doctorPassed, formatDoctor, runDoctor } from "./commands/doctor.ts";
import { formatRunSummary } from "./commands/run.ts";
import { runCheck, type RunOptions } from "./engine.ts";
import { DISCLAIMER_SHORT } from "./core/disclaimer.ts";
import { ToolError } from "./core/errors.ts";
import { EXIT, EXIT_MEANING, type ExitCode } from "./core/exit-codes.ts";
import { type DiffOptions, runDiff } from "./migrate/diff.ts";
import { DEFAULT_OUT_DIR, writeReports } from "./report/write.ts";

export const DEFAULT_WORKDIR = ".tlc-work";

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

const consoleOutput: Output = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

export function toolVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

export function helpText(): string {
  const codes = (Object.entries(EXIT_MEANING) as [string, string][]).map(([code, meaning]) => `  ${code}  ${meaning}`);
  return [
    `tenant-leak-check ${toolVersion()}`,
    "Tests whether one tenant (or an anonymous visitor) can read or change another tenant's data",
    "in a LOCAL Supabase project built from its migrations. It never connects to hosted projects.",
    "",
    "Usage:",
    "  tenant-leak-check run --project <folder>",
    "      Build a local copy of the project from its migrations and test tenant isolation.",
    "  tenant-leak-check diff --project <folder> --migration <file.sql> [--migration <file.sql> ...]",
    "      Migration mode: test the project before and after the new migration(s) and report what changed.",
    "",
    "Options for run and diff:",
    `  --out <folder>        Where report.html, report.md and report.json go (default: ./${DEFAULT_OUT_DIR})`,
    "  --config <file>       Tenancy overrides (default: <project folder>/tenant-leak-check.json)",
    `  --workdir <folder>    Where the sandbox is kept (default: ./${DEFAULT_WORKDIR})`,
    "  --keep-running        Leave the local stack running afterwards",
    "",
    "Other commands:",
    "  tenant-leak-check doctor [--workdir <folder>]   Check that Docker, the Supabase CLI and memory are ready",
    "  tenant-leak-check --help                         Show this help",
    "  tenant-leak-check --version                      Show the version",
    "",
    "Exit codes:",
    ...codes,
    "",
    DISCLAIMER_SHORT,
  ].join("\n");
}

const SHARED_OPTIONS = {
  project: { type: "string" },
  config: { type: "string" },
  out: { type: "string", default: DEFAULT_OUT_DIR },
  workdir: { type: "string", default: DEFAULT_WORKDIR },
  "keep-running": { type: "boolean", default: false },
} as const;

function requireProject(project: string | undefined, command: string): string {
  if (!project) {
    throw new ToolError("Missing --project.", `Give the folder that contains supabase/migrations, for example: tenant-leak-check ${command} --project ../my-app`);
  }
  return resolve(project);
}

async function runCommand(args: string[], io: Output): Promise<ExitCode> {
  const { values } = parseArgs({ args, options: SHARED_OPTIONS, strict: true, allowPositionals: false });
  const options: RunOptions = {
    projectDir: requireProject(values.project, "run"),
    workdir: resolve(values.workdir),
    keepRunning: values["keep-running"],
    toolVersion: toolVersion(),
    log: (line) => io.err(line),
  };
  if (values.config) options.configPath = resolve(values.config);
  const result = await runCheck(options);
  const reports = await writeReports(result, values.out);
  io.out(formatRunSummary(result, reports));
  return result.summary.exitCode;
}

async function diffCommand(args: string[], io: Output): Promise<ExitCode> {
  const { values } = parseArgs({
    args,
    options: { ...SHARED_OPTIONS, migration: { type: "string", multiple: true, default: [] } },
    strict: true,
    allowPositionals: false,
  });
  const options: DiffOptions = {
    projectDir: requireProject(values.project, "diff"),
    migrations: values.migration.map((path) => resolve(path)),
    workdir: resolve(values.workdir),
    keepRunning: values["keep-running"],
    toolVersion: toolVersion(),
    log: (line) => io.err(line),
  };
  if (values.config) options.configPath = resolve(values.config);
  const result = await runDiff(options);
  const reports = await writeReports(result, values.out);
  io.out(formatRunSummary(result, reports));
  return result.summary.exitCode;
}

async function doctorCommand(args: string[], io: Output): Promise<ExitCode> {
  const { values } = parseArgs({
    args,
    options: { workdir: { type: "string", default: DEFAULT_WORKDIR } },
    strict: true,
    allowPositionals: false,
  });
  const checks = await runDoctor({ workdir: resolve(values.workdir) });
  io.out(["tenant-leak-check doctor", "", formatDoctor(checks), "", DISCLAIMER_SHORT].join("\n"));
  return doctorPassed(checks) ? EXIT.clean : EXIT.toolError;
}

/** Runs the CLI and returns the exit code instead of exiting, so tests can call it directly. */
export async function main(argv: readonly string[], io: Output = consoleOutput): Promise<ExitCode> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(helpText());
        return EXIT.clean;
      case "--version":
      case "-v":
        io.out(toolVersion());
        return EXIT.clean;
      case "doctor":
        return await doctorCommand(rest, io);
      case "run":
        return await runCommand(rest, io);
      case "diff":
        return await diffCommand(rest, io);
      default:
        throw new ToolError(`Unknown command "${command}".`, "Run tenant-leak-check --help to see the available commands.");
    }
  } catch (error) {
    if (error instanceof ToolError) {
      io.err(`Error: ${error.message}`);
      if (error.hint) io.err(error.hint);
    } else if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
      io.err(`Error: ${error.message}`);
      io.err("Run tenant-leak-check --help to see the available options.");
    } else {
      io.err(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return EXIT.toolError;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
