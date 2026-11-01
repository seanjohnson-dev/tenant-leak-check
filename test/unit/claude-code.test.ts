import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { helpText } from "../../src/cli.ts";
import { DISCLAIMER_SHORT } from "../../src/core/disclaimer.ts";
import { EXIT, EXIT_MEANING } from "../../src/core/exit-codes.ts";

/* The Claude Code command and skill ("run the leak check"): integrations/claude-code/, copied into .claude/. */

const repo = fileURLToPath(new URL("../../", import.meta.url));
const FILES = ["commands/leak-check.md", "skills/tenant-leak-check/SKILL.md"] as const;
const read = (path: string): string => readFileSync(`${repo}${path}`, "utf8");

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "missing frontmatter");
  return Object.fromEntries((match[1] as string).split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
}

describe("Claude Code command and skill", () => {
  it("the skill has a name and a description that matches \"run the leak check\"", () => {
    const meta = frontmatter(read("integrations/claude-code/skills/tenant-leak-check/SKILL.md"));
    assert.equal(meta.name, "tenant-leak-check");
    assert.match(meta.description ?? "", /run the leak check/);
  });

  it("the command takes the project folder and an optional migration", () => {
    const text = read("integrations/claude-code/commands/leak-check.md");
    const meta = frontmatter(text);
    assert.ok(meta.description);
    assert.match(meta["argument-hint"] ?? "", /project folder/);
    assert.match(text, /\$ARGUMENTS/);
  });

  for (const file of FILES) {
    it(`${file}: only uses commands and options the CLI really has`, () => {
      const text = read(`integrations/claude-code/${file}`);
      const help = helpText();
      for (const match of text.matchAll(/node src\/cli\.ts (\w+)((?: --[a-z-]+)*)/g)) {
        assert.ok(help.includes(`tenant-leak-check ${match[1]}`), `unknown command ${match[1]}`);
      }
      for (const option of new Set(text.match(/--[a-z][a-z-]+/g) ?? [])) assert.ok(help.includes(option), `unknown option ${option}`);
    });

    it(`${file}: ends with the disclaimer and keeps the safety rules`, () => {
      const text = read(`integrations/claude-code/${file}`);
      assert.ok(text.includes(DISCLAIMER_SHORT));
      assert.match(text, /never point it at a hosted project|Never point the tool/i);
      assert.match(text, /\.env/);
      assert.match(text, /never modify the target project/i);
    });

    it(`${file}: if installed in .claude/, the copy matches`, () => {
      const installed = `${repo}.claude/${file}`;
      if (existsSync(installed)) assert.equal(readFileSync(installed, "utf8"), read(`integrations/claude-code/${file}`));
    });
  }

  it("the skill explains every exit code the same way the CLI does", () => {
    const text = read("integrations/claude-code/skills/tenant-leak-check/SKILL.md");
    for (const code of Object.values(EXIT)) assert.match(text, new RegExp(`\`${code}\` `), `exit code ${code} (${EXIT_MEANING[code]}) is not explained`);
  });

  it("nothing tells Claude to install into the home folder", () => {
    for (const file of FILES) assert.doesNotMatch(read(`integrations/claude-code/${file}`), /cp .*~\/\.claude|into ~\/\.claude/);
  });
});
