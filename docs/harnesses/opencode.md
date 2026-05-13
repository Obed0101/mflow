# opencode Harness Guide

mflow is not tied to a specific agent runtime. For opencode, use the CLI daemon in each synced worktree.

## Start a shared room

```bash
export MFLOW_SECRET="$(openssl rand -hex 32)"
mflow start --room project-x/opencode --secret "$MFLOW_SECRET"
```

Join from another worktree:

```bash
mflow start --room project-x/opencode --secret "$MFLOW_SECRET"
```

## Suggested command aliases

Add shell or opencode task aliases for common controls:

```bash
mflow status --watch
mflow pause
mflow resume
mflow locks
```

## MCP setup

If your opencode setup supports stdio MCP servers, register mflow with the same command shape used by other MCP clients:

```json
{
  "mcpServers": {
    "mflow": {
      "command": "bunx",
      "args": ["-p", "mflow-cli", "mflow-mcp", "--root", "/absolute/path/to/repo"]
    }
  }
}
```

Recommended agent instruction:

```text
Use mflow status before long tasks, `mflow lock <path> --wait --timeout 60s` before high-conflict edits, mflow pause before commit/rebase/reset, and mflow resume after tests and git operations. Never print room secrets.
```

## File locking

Before assigning multiple agents around the same area:

```bash
mflow lock packages/daemon/src/sync.ts --duration 2m --wait --timeout 60s
```

Release when done:

```bash
mflow unlock packages/daemon/src/sync.ts
```

opencode plugins can add stronger pre-edit enforcement by acquiring a queued mflow lock in a tool-execute-before hook. Keep the CLI/MCP lock protocol as the fallback because plugin coverage depends on the exact tool path.

## Optional edit plugin

Install the project-local plugin:

```bash
mflow install-hooks --harness opencode
```

This writes `.opencode/plugins/mflow-lock.js`. OpenCode loads project plugins at startup. The plugin runs before `edit`, `write`, `multiedit`, and `apply_patch`; for `apply_patch`, it extracts paths from patch marker lines before calling:

```bash
mflow lock <path> --duration "${MFLOW_LOCK_DURATION:-30s}" --wait --timeout "${MFLOW_LOCK_TIMEOUT:-60s}" --priority "${MFLOW_LOCK_PRIORITY:-0}"
```

If a lock cannot be acquired before timeout, the plugin throws and blocks the tool execution.

Set `MFLOW_BIN` if the `mflow` executable is not on the plugin process `PATH`.

## Self-hosting

```bash
mflow start --room project-x/opencode --secret "$MFLOW_SECRET" --signaling ws://localhost:8787
```
