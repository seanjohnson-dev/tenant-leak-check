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
    "  tenant-leak-check doctor [--workdir <folder>]   Check that Docker, the Supabase CLI and memory are ready",
    "  tenant-leak-check run --project <folder>         Build a local copy of the project and test tenant isolation",
    "        [--config <file>]                          Tenancy overrides (default: <folder>/tenant-leak-check.json)",
    "        [--workdir <folder>]                       Where the sandbox is kept (default: ./.tlc-work)",
    "        [--keep-running]                           Leave the local stack running afterwards",
    "  tenant-leak-check --help                         Show this help",
    "  tenant-leak-check --version                      Show the version",
    "",
    "Exit codes:",
    ...codes,
    "",
    DISCLAIMER_SHORT,
  ].join("\n");
}

async function runCommand(args: string[], io: Output): Promise<ExitCode> {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string" },
      config: { type: "string" },
      workdir: { type: "string", default: DEFAULT_WORKDIR },
      "keep-running": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.project) {
    throw new ToolError("Missing --project.", "Give the folder that contains supabase/migrations, for example: tenant-leak-check run --project ../my-app");
  }
  const options: RunOptions = {
    projectDir: resolve(values.project),
    workdir: resolve(values.workdir),
    keepRunning: values["keep-running"],
    toolVersion: toolVersion(),
    log: (line) => io.err(line),
  };
  if (values.config) options.configPath = resolve(values.config);
  const result = await runCheck(options);
  io.out(formatRunSummary(result));
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
