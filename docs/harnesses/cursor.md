# Cursor Harness Guide

Use mflow with Cursor by running the CLI daemon in every synced worktree. Cursor MCP is optional and should control status, pause/resume, and locks only.

## Start sync

```bash
export MFLOW_SECRET="$(openssl rand -hex 32)"
mflow start --room project-x/cursor --secret "$MFLOW_SECRET"
```

Join from another worktree or machine:

```bash
mflow start --room project-x/cursor --secret "$MFLOW_SECRET"
```

## Cursor MCP setup

Project-scoped config lives at `.cursor/mcp.json`. Global config lives at `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "mflow": {
      "command": "bunx",
      "args": ["-p", "mflow-sdk", "mflow-mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

Then restart Cursor or reload MCP tools from Cursor settings.

## Operating rules

- Ask Cursor Agent to call mflow status before long tasks.
- Lock files before parallel edits to shared code.
- Pause before commit, rebase, reset, or branch surgery.
- Resume after tests and git operations.

```bash
mflow status
mflow lock src/shared/schema.ts --duration 2m
mflow pause
git status --short
git commit -m "feat: change"
mflow resume
```
