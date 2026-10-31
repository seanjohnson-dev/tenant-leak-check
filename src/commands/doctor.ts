import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The Supabase CLI version this tool was built and tested with. */
export const TESTED_SUPABASE_CLI = "2.122.0";
export const MIN_NODE_MAJOR = 24;
/** The reduced stack measured about 390 MB; these limits leave room for the tool and Postgres under load. */
export const MEMORY_FAIL_BELOW_MB = 768;
export const MEMORY_WARN_BELOW_MB = 1536;
export const COMMAND_TIMEOUT_MS = 20_000;

export type CheckStatus = "ok" | "note" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface CommandResult {
  /** The program could not be found at all. */
  missing: boolean;
  /** The program ran and exited with code 0. */
  ok: boolean;
  /** The program was stopped because it did not answer in time. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export type Version = readonly [number, number, number];

export function parseVersion(text: string): Version | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Reads MemAvailable (in MB) from the text of /proc/meminfo. */
export function parseMemAvailableMb(meminfo: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  return match ? Math.floor(Number(match[1]) / 1024) : undefined;
}

export function checkNode(version: string): DoctorCheck {
  const parsed = parseVersion(version);
  if (parsed && parsed[0] >= MIN_NODE_MAJOR) {
    return { name: "Node.js", status: "ok", detail: `v${parsed.join(".")}` };
  }
  return {
    name: "Node.js",
    status: "fail",
    detail: `Found ${version}; version ${MIN_NODE_MAJOR} or newer is needed.`,
    fix: `Install Node.js ${MIN_NODE_MAJOR} LTS from https://nodejs.org/ and run the command again.`,
  };
}

export function checkDocker(result: CommandResult): DoctorCheck {
  const name = "Docker";
  if (result.missing) {
    return {
      name,
      status: "fail",
      detail: "The docker command is not installed.",
      fix: "Install Docker Engine: https://docs.docker.com/engine/install/",
    };
  }
  if (result.ok) {
    const version = parseVersion(result.stdout);
    return {
      name,
      status: "ok",
      detail: `Docker Engine ${version ? version.join(".") : result.stdout.trim()} is running and reachable.`,
    };
  }
  if (result.timedOut) {
    return {
      name,
      status: "fail",
      detail: `Docker did not answer within ${COMMAND_TIMEOUT_MS / 1000} seconds.`,
      fix: "Check that the Docker daemon is healthy (docker info), restart it if needed, and try again.",
    };
  }
  if (/permission denied/i.test(result.stderr)) {
    return {
      name,
      status: "fail",
      detail: "Docker is running, but this user is not allowed to use it.",
      fix:
        "Add your user to the docker group (sudo usermod -aG docker $USER), then open a new login shell " +
        "(or run the command inside: sg docker -c \"...\").",
    };
  }
  return {
    name,
    status: "fail",
    detail: "Docker is installed, but the Docker daemon is not running.",
    fix: "Start Docker (sudo systemctl start docker, or on machines without systemd: sudo dockerd).",
  };
}

export function checkSupabaseCli(result: CommandResult): DoctorCheck {
  const name = "Supabase CLI";
  if (result.missing || !result.ok) {
    return {
      name,
      status: "fail",
      detail: result.missing ? "The supabase command is not installed." : "The supabase command did not run.",
      fix: "Install the Supabase CLI: https://supabase.com/docs/guides/local-development/cli/getting-started",
    };
  }
  const found = parseVersion(result.stdout);
  const tested = parseVersion(TESTED_SUPABASE_CLI) as Version;
  if (!found) {
    return { name, status: "warn", detail: `Could not read the version from: ${result.stdout.trim()}` };
  }
  if (compareVersions(found, tested) < 0) {
    return {
      name,
      status: "warn",
      detail: `Version ${found.join(".")} is older than the version this tool was tested with (${TESTED_SUPABASE_CLI}).`,
      fix: "Update the Supabase CLI if a check fails to start.",
    };
  }
  return { name, status: "ok", detail: `Version ${found.join(".")}` };
}

export function checkMemory(availableMb: number | undefined): DoctorCheck {
  const name = "Free memory";
  if (availableMb === undefined) {
    return { name, status: "note", detail: "Could not measure free memory on this system; about 1.5 GB free is recommended." };
  }
  const needed = `The local Supabase stack needs about 400 MB, and ${MEMORY_WARN_BELOW_MB} MB free is recommended.`;
  if (availableMb < MEMORY_FAIL_BELOW_MB) {
    return {
      name,
      status: "fail",
      detail: `Only ${availableMb} MB available. ${needed}`,
      fix: "Close other programs or stop other Docker containers, then try again.",
    };
  }
  if (availableMb < MEMORY_WARN_BELOW_MB) {
    return { name, status: "warn", detail: `${availableMb} MB available. ${needed}` };
  }
  return { name, status: "ok", detail: `${availableMb} MB available.` };
}

/**
 * On some container-like hosts, pre-existing firewall rules drop traffic between
 * Docker containers when bridged traffic is passed through iptables. This is only a
 * hint: on most hosts the value 1 is normal and harmless.
 */
export function checkBridgeNetfilter(value: string | undefined): DoctorCheck | undefined {
  if (value?.trim() !== "1") return undefined;
  return {
    name: "Docker networking",
    status: "note",
    detail:
      "Traffic between containers passes through iptables. If supabase start fails at \"Initialising schema\" " +
      "with a database connection error, the host's firewall is blocking container-to-container traffic.",
    fix: "sudo sysctl -w net.bridge.bridge-nf-call-iptables=0 net.bridge.bridge-nf-call-ip6tables=0",
  };
}

export async function checkWorkdir(dir: string): Promise<DoctorCheck> {
  const probe = join(dir, `.doctor-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok");
    await rm(probe);
    return { name: "Work folder", status: "ok", detail: `${dir} is writable.` };
  } catch (error) {
    return {
      name: "Work folder",
      status: "fail",
      detail: `Cannot write to ${dir}: ${(error as Error).message}`,
      fix: "Choose a writable folder with --workdir <folder>.",
    };
  }
}

export function runCommand(program: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(program, args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolve({
        missing: code === "ENOENT",
        ok: error === null,
        timedOut: error !== null && error.killed === true,
        stdout,
        stderr,
      });
    });
  });
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface DoctorOptions {
  workdir: string;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const [docker, supabase, meminfo, bridge, workdir] = await Promise.all([
    runCommand("docker", ["version", "--format", "{{.Server.Version}}"]),
    runCommand("supabase", ["--version"]),
    readOptional("/proc/meminfo"),
    readOptional("/proc/sys/net/bridge/bridge-nf-call-iptables"),
    checkWorkdir(options.workdir),
  ]);
  const checks: DoctorCheck[] = [
    checkNode(process.version),
    checkDocker(docker),
    checkSupabaseCli(supabase),
    checkMemory(meminfo === undefined ? undefined : parseMemAvailableMb(meminfo)),
    workdir,
  ];
  const bridgeNote = docker.ok ? checkBridgeNetfilter(bridge) : undefined;
  if (bridgeNote) checks.push(bridgeNote);
  return checks;
}

export function doctorPassed(checks: readonly DoctorCheck[]): boolean {
  return checks.every((check) => check.status !== "fail");
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  const lines = checks.flatMap((check) => {
    const head = `  ${check.status.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}`;
    return check.fix ? [head, `  ${" ".repeat(4)}  ${" ".repeat(width)}  Fix: ${check.fix}`] : [head];
  });
  const failures = checks.filter((check) => check.status === "fail").length;
  const verdict =
    failures === 0
      ? "Ready: all required checks passed."
      : `Not ready: ${failures} problem${failures === 1 ? "" : "s"} must be fixed first.`;
  return [...lines, "", verdict].join("\n");
}
