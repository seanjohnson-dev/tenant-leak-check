import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  MEMORY_FAIL_BELOW_MB,
  MEMORY_WARN_BELOW_MB,
  TESTED_SUPABASE_CLI,
  checkBridgeNetfilter,
  checkDocker,
  checkMemory,
  checkNode,
  checkSupabaseCli,
  checkWorkdir,
  compareVersions,
  doctorPassed,
  formatDoctor,
  parseMemAvailableMb,
  parseVersion,
  runCommand,
  type CommandResult,
} from "../../src/commands/doctor.ts";

const ran = (stdout: string): CommandResult => ({ missing: false, ok: true, timedOut: false, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({ missing: false, ok: false, timedOut: false, stdout: "", stderr });
const missing: CommandResult = { missing: true, ok: false, timedOut: false, stdout: "", stderr: "" };
const hung: CommandResult = { missing: false, ok: false, timedOut: true, stdout: "", stderr: "" };

describe("version helpers", () => {
  it("parses the first x.y.z in the text", () => {
    assert.deepEqual(parseVersion("v24.22.1"), [24, 22, 1]);
    assert.deepEqual(parseVersion("2.122.0\nA new version of Supabase CLI is available: v2.130.0"), [2, 122, 0]);
    assert.equal(parseVersion("unknown"), undefined);
  });

  it("compares numerically, not as text", () => {
    assert.equal(compareVersions([2, 122, 0], [2, 99, 9]), 1);
    assert.equal(compareVersions([2, 9, 0], [2, 10, 0]), -1);
    assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
  });
});

describe("checkNode", () => {
  it("accepts Node 24 and newer", () => {
    assert.equal(checkNode("v24.0.0").status, "ok");
    assert.equal(checkNode("v26.1.0").status, "ok");
  });

  it("fails older Node with a fix", () => {
    const check = checkNode("v22.11.0");
    assert.equal(check.status, "fail");
    assert.match(check.fix ?? "", /nodejs\.org/);
  });
});

describe("checkDocker", () => {
  it("reports the engine version when reachable", () => {
    const check = checkDocker(ran("29.9.2\n"));
    assert.equal(check.status, "ok");
    assert.match(check.detail, /29\.9\.2/);
  });

  it("explains a missing install", () => {
    const check = checkDocker(missing);
    assert.equal(check.status, "fail");
    assert.match(check.fix ?? "", /docs\.docker\.com/);
  });

  it("explains a permissions problem", () => {
    const check = checkDocker(failed("permission denied while trying to connect to the Docker daemon socket"));
    assert.equal(check.status, "fail");
    assert.match(check.fix ?? "", /docker group/);
  });

  it("says a hung daemon timed out instead of calling it stopped", () => {
    const check = checkDocker(hung);
    assert.equal(check.status, "fail");
    assert.match(check.detail, /did not answer within 20 seconds/);
  });

  it("explains a stopped daemon", () => {
    const check = checkDocker(failed("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"));
    assert.equal(check.status, "fail");
    assert.match(check.fix ?? "", /dockerd/);
  });
});

describe("checkSupabaseCli", () => {
  it("accepts the tested version", () => {
    assert.equal(checkSupabaseCli(ran(`${TESTED_SUPABASE_CLI}\n`)).status, "ok");
  });

  it("warns on an older version", () => {
    assert.equal(checkSupabaseCli(ran("1.200.3")).status, "warn");
  });

  it("fails when not installed", () => {
    const check = checkSupabaseCli(missing);
    assert.equal(check.status, "fail");
    assert.match(check.fix ?? "", /supabase\.com/);
  });
});

describe("memory", () => {
  it("reads MemAvailable from /proc/meminfo", () => {
    const meminfo = "MemTotal:       16386048 kB\nMemFree:         2876000 kB\nMemAvailable:    5767168 kB\n";
    assert.equal(parseMemAvailableMb(meminfo), 5632);
    assert.equal(parseMemAvailableMb("MemTotal: 1 kB\n"), undefined);
  });

  it("fails, warns or passes at the documented limits", () => {
    assert.equal(checkMemory(MEMORY_FAIL_BELOW_MB - 1).status, "fail");
    assert.equal(checkMemory(MEMORY_FAIL_BELOW_MB).status, "warn");
    assert.equal(checkMemory(MEMORY_WARN_BELOW_MB - 1).status, "warn");
    assert.equal(checkMemory(MEMORY_WARN_BELOW_MB).status, "ok");
    assert.equal(checkMemory(undefined).status, "note");
  });
});

describe("checkBridgeNetfilter", () => {
  it("adds a note with the fix only when bridged traffic goes through iptables", () => {
    assert.equal(checkBridgeNetfilter(undefined), undefined);
    assert.equal(checkBridgeNetfilter("0\n"), undefined);
    const note = checkBridgeNetfilter("1\n");
    assert.equal(note?.status, "note");
    assert.match(note?.fix ?? "", /bridge-nf-call-iptables=0/);
  });
});

describe("checkWorkdir", () => {
  it("passes for a writable folder and leaves nothing behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tlc-doctor-"));
    try {
      const check = await checkWorkdir(join(dir, "work"));
      assert.equal(check.status, "ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails when the path is a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tlc-doctor-"));
    try {
      const file = join(dir, "not-a-folder");
      await writeFile(file, "x");
      const check = await checkWorkdir(file);
      assert.equal(check.status, "fail");
      assert.match(check.fix ?? "", /--workdir/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runCommand", () => {
  it("captures output of a program that succeeds", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('hi')"]);
    assert.deepEqual(result, { missing: false, ok: true, timedOut: false, stdout: "hi", stderr: "" });
  });

  it("captures stderr of a program that fails", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(2)"]);
    assert.equal(result.ok, false);
    assert.equal(result.missing, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.stderr, "boom");
  });

  it("reports a program that is not installed", async () => {
    const result = await runCommand("tlc-no-such-program-xyz", []);
    assert.equal(result.missing, true);
    assert.equal(result.ok, false);
  });
});

describe("doctor summary", () => {
  it("passes with warnings and notes, fails with any failure", () => {
    assert.equal(doctorPassed([{ name: "a", status: "ok", detail: "" }, { name: "b", status: "warn", detail: "" }]), true);
    assert.equal(doctorPassed([{ name: "a", status: "note", detail: "" }, { name: "b", status: "fail", detail: "" }]), false);
  });

  it("prints each check, its fix, and a verdict", () => {
    const text = formatDoctor([
      { name: "Docker", status: "fail", detail: "Not running.", fix: "Start it." },
      { name: "Node.js", status: "ok", detail: "v24.22.1" },
    ]);
    assert.match(text, /fail\s+Docker\s+Not running\./);
    assert.match(text, /Fix: Start it\./);
    assert.match(text, /Not ready: 1 problem must be fixed first\./);
  });
});
