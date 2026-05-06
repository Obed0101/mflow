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

mflow includes an MCP package, but the CLI-first workflow is the stable baseline. If wiring MCP tools into Codex, keep them thin: status, peers, pause/resume, and locks. Do not make hosted account login a dependency for self-hosted rooms.
