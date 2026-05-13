# Codex Harness Guide

Use mflow with Codex by starting the daemon in each worktree that should share file changes.

## Basic workflow

In the first worktree:

```bash
export MFLOW_SECRET="$(openssl rand -hex 32)"
mflow start --room project-x/codex --secret "$MFLOW_SECRET"
```

In another Codex worktree or terminal:

```bash
mflow start --room project-x/codex --secret "$MFLOW_SECRET"
```

## Recommended operating pattern

- Start mflow before parallel agent work.
- Keep room names scoped to repo + branch or sprint.
- Use `mflow status --watch` in a spare terminal.
- Use `mflow lock <path> --wait --timeout 60s` before editing hot shared files.
- Use `mflow pause` before git commit/rebase operations, then `mflow resume`.

## Self-hosted relay

```bash
mflow start \
  --room project-x/codex \
  --secret "$MFLOW_SECRET" \
  --signaling ws://localhost:8787
```

## MCP note

mflow includes an MCP server. Keep it thin: status, peers, pause/resume, and locks. Do not make hosted account login a dependency for self-hosted rooms.

Install the MCP server for a repo:

```bash
codex mcp add mflow -- bunx -p mflow-cli mflow-mcp --root /absolute/path/to/repo
```

Recommended Codex instruction:

```text
When working in this repo, use mflow before coordinated edits. Call mflow status at task start, lock hot files with `mflow lock <path> --wait --timeout 60s` before parallel edits, pause before commit/rebase/reset, and resume after tests and git operations. Never print room secrets.
```

If your Codex setup supports skills, copy or symlink `skills/mflow/SKILL.md` into the runtime skill directory and mention the mflow skill in repo instructions.

Codex integration is currently MCP/skill-first. Do not assume file-edit hooks block every write path unless the exact Codex version has been verified with `apply_patch` and shell-write tests.

`mflow install-hooks` currently targets Claude Code and OpenCode. For Codex, keep using MCP/skill instructions until file-edit hook coverage is verified for the exact Codex build in use.

For Codex patch-heavy workflows, use the broker where possible:

```bash
mflow apply-patch patch.txt --timeout 60s --priority 0
```

For broad assignments, reserve a cooperative scope before editing:

```bash
mflow claim "packages/daemon/src/**" --timeout 2m
```
