# Claude Code Harness Guide

mflow can coordinate multiple Claude Code worktrees by syncing project files through a shared room.

## CLI-first setup

First worktree:

```bash
export MFLOW_SECRET="$(openssl rand -hex 32)"
mflow start --room project-x/claude --secret "$MFLOW_SECRET"
```

Second worktree:

```bash
mflow start --room project-x/claude --secret "$MFLOW_SECRET"
```

## Multi-agent recommendations

- Give each worker a separate worktree or folder.
- Keep generated build/cache output ignored.
- Lock files before high-conflict edits:

```bash
mflow lock src/core/sync.ts --duration 2m
```

- Pause during git operations:

```bash
mflow pause
git commit -m "feat: update sync"
mflow resume
```

## MCP setup

Use MCP for operational controls only. The core sync path should remain CLI + daemon + room secret so the workflow is portable across harnesses.

```bash
claude mcp add mflow -- bunx mflow-mcp --root /absolute/path/to/repo
```

Recommended Claude Code instruction:

```text
When working in this repo, use mflow for coordination. Check status at task start, lock hot files before parallel edits, pause before commit/rebase/reset, resume after tests and git operations, and never print room secrets.
```

If your Claude Code setup supports skills, copy `skills/mflow/SKILL.md` into the relevant skill location and reference it from project instructions.
