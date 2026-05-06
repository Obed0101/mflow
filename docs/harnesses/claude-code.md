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

## MCP integration boundary

Use MCP for operational controls only if your Claude Code setup supports it. The core sync path should remain CLI + daemon + room secret so the workflow is portable across harnesses.
