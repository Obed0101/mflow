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
- Lock files before high-conflict edits. Use `--wait` so agents queue instead of polling manually:

```bash
mflow lock src/core/sync.ts --duration 2m --wait --timeout 60s
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
claude mcp add mflow -- bunx -p mflow-cli mflow-mcp --root /absolute/path/to/repo
```

Recommended Claude Code instruction:

```text
When working in this repo, use mflow for coordination. Check status at task start, lock hot files with `mflow lock <path> --wait --timeout 60s` before parallel edits, pause before commit/rebase/reset, resume after tests and git operations, and never print room secrets.
```

If your Claude Code setup supports skills, copy `skills/mflow/SKILL.md` into the relevant skill location and reference it from project instructions.

Claude Code hook integrations can add stronger pre-edit enforcement by acquiring a queued mflow lock before Edit/Write-style tools run. Keep the CLI/MCP lock protocol as the fallback because hooks are harness-specific.

## Optional edit hook

Install the project-local hook:

```bash
mflow install-hooks --harness claude
```

This writes `.claude/settings.local.json` and `.claude/hooks/mflow-lock.mjs`. The hook runs before `Edit`, `Write`, and `MultiEdit`, extracts the file path, and calls:

```bash
mflow lock <path> --duration "${MFLOW_LOCK_DURATION:-30s}" --wait --timeout "${MFLOW_LOCK_TIMEOUT:-60s}" --priority "${MFLOW_LOCK_PRIORITY:-0}"
```

If the lock cannot be acquired before timeout, the hook denies the tool call. Restart Claude Code or inspect `/hooks` if the hook does not appear.

Set `MFLOW_BIN` if the `mflow` executable is not on the hook process `PATH`.
