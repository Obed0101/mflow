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
- Use `mflow lock <path>` before editing hot shared files.
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
codex mcp add mflow -- bunx -p mflow-sdk mflow-mcp --root /absolute/path/to/repo
```

Recommended Codex instruction:

```text
When working in this repo, use mflow before coordinated edits. Call mflow status at task start, lock hot files before parallel edits, pause before commit/rebase/reset, and resume after tests and git operations. Never print room secrets.
```

If your Codex setup supports skills, copy or symlink `skills/mflow/SKILL.md` into the runtime skill directory and mention the mflow skill in repo instructions.
