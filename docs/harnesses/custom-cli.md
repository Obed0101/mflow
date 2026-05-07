# Custom CLI or Agent Harness Guide

mflow exposes a CLI and daemon IPC model that custom harnesses can use without adopting any hosted account system.

## Baseline integration

Start mflow as a sidecar process before agent work:

```bash
mflow start --room <repo-or-task-room> --secret "$MFLOW_SECRET"
```

Stop it when the workflow ends:

```bash
mflow stop
```

## MCP setup

Use the stdio MCP server when the harness can load MCP tools:

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

Use `MFLOW_PROJECT_ROOT` if the client cannot pass arguments:

```json
{
  "mcpServers": {
    "mflow": {
      "command": "bunx",
      "args": ["-p", "mflow-cli", "mflow-mcp"],
      "env": {
        "MFLOW_PROJECT_ROOT": "/absolute/path/to/repo"
      }
    }
  }
}
```

## Recommended controls

A harness can shell out to:

```bash
mflow status
mflow pause
mflow resume
mflow lock <path> --duration 2m
mflow unlock <path>
mflow locks
```

## IPC concept

The CLI talks to the daemon through a Unix domain socket under `.mflow/daemon.sock` using newline-delimited JSON. Public harnesses should prefer CLI/MCP wrappers over relying on private IPC details unless they vendor a compatible adapter.

High-level control surface:

- status
- peers
- pause/resume
- lock/unlock/list locks
- stop

## Safety rules for harness authors

- Never print room secrets into logs.
- Pause mflow around git commits, rebases, and destructive rewrites.
- Use file locks around hot paths.
- Keep generated files ignored.
- Do not require hosted login for self-hosted or local rooms.
