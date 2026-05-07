---
name: mflow
description: Use when working in a repo that uses mflow, coordinating multiple AI agents/worktrees, setting up mflow sync, installing mflow MCP in Codex/Claude Code/Cursor/opencode, or before git operations where synced file changes may affect commits. Applies to CLI, MCP, room secrets, pause/resume, locks, status checks, and safe commit workflows.
---

# mflow Skill

mflow keeps local worktrees synchronized while humans or AI agents edit. Treat it as a live sync layer, not as git, not as a secret manager, and not as a substitute for review.

## Non-negotiables

- Never print, commit, log, or paste room secrets/API keys.
- Before commit/rebase/reset/branch surgery: pause mflow, inspect status and git diff, do the git operation, then resume.
- Use locks for hot files before parallel edits: shared config, migrations, schemas, auth, package manifests, generated public docs.
- If mflow is absent or stopped, do not assume peers are synced. Say so and continue with normal git safety.
- Hosted accounts are optional. The core OSS workflow is room + strong shared secret.

## Quick start

```bash
npm i -g mflow-sdk
export MFLOW_SECRET="$(openssl rand -hex 32)"
mflow start --room <repo>/<branch-or-task> --secret "$MFLOW_SECRET"
mflow status --watch
```

Join another worktree with the same room and secret:

```bash
mflow start --room <repo>/<branch-or-task> --secret "$MFLOW_SECRET"
```

## Safe agent workflow

1. Check sync state:

```bash
mflow status
mflow locks
```

2. Lock high-conflict files before editing:

```bash
mflow lock path/to/file --duration 2m
```

3. Edit and verify normally.

4. Before git operations:

```bash
mflow pause
git status --short
git diff --check
# run tests/checks relevant to the change
git add ...
git commit -m "..."
mflow resume
mflow status
```

5. Release locks when done:

```bash
mflow unlock path/to/file
```

## If someone forgets to pause before commit

mflow watches `.git/index.lock` and auto-pauses during active git operations, but that is a last safety net. The danger window is before the lock appears: remote synced edits may arrive and change the working tree before staging or commit. If this happened:

```bash
git status --short
git show --stat --oneline HEAD
mflow status
```

If unwanted synced files entered the commit, amend or revert before pushing.

## MCP policy for agents

MCP tools are for control, not for replacing the CLI sync model. Prefer these behaviors:

- On task start: call status/peers if tools are available.
- Before high-conflict edits: call lock.
- Before commit/rebase/reset: call pause.
- After git operation and tests: call resume.
- If MCP fails, fall back to CLI commands.

Expected mflow MCP tools include status, peers, pause, resume, lock, unlock, and locks.

## MCP install snippets

Use absolute project paths when possible. Replace `/path/to/repo` with the synced repo root.

### Codex

```bash
codex mcp add mflow -- bunx mflow-mcp --root /path/to/repo
```

### Claude Code

```bash
claude mcp add mflow -- bunx mflow-mcp --root /path/to/repo
```

### Cursor

Create `.cursor/mcp.json` in the repo or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "mflow": {
      "command": "bunx",
      "args": ["mflow-mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

### Other MCP clients

Use stdio:

```json
{
  "mcpServers": {
    "mflow": {
      "command": "bunx",
      "args": ["mflow-mcp", "--root", "/path/to/repo"]
    }
  }
}
```

## Self-hosted relay

```bash
mflow start \
  --room <repo>/<task> \
  --secret "$MFLOW_SECRET" \
  --signaling ws://localhost:8787
```
