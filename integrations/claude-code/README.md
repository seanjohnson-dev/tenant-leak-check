# Claude Code command and skill

These two files let you say "run the leak check" (or type `/leak-check <project folder>`) in Claude Code, opened in this repository:

- `commands/leak-check.md`: the `/leak-check` command.
- `skills/tenant-leak-check/SKILL.md`: the skill Claude Code uses when you ask in plain words.

Claude Code reads them from the repository's own `.claude/` folder. To switch them on, run this once from the repository root:

```sh
mkdir -p .claude && cp -R integrations/claude-code/commands integrations/claude-code/skills .claude/
```

Nothing is installed into your home folder (`~/.claude`). The unit tests check that the `.claude/` copies, when present, are identical to these files.
