# mflow

Open-source real-time file sync for AI agent teams and developers working across multiple worktrees or machines.

mflow keeps local project files in sync while agents or humans edit. It is CLI-first, self-hostable, room-secret based, and designed to reduce blind parallel edits before you commit to git.

## Current release status

mflow is being prepared for its first public OSS release. The initial npm package name is `mflow-sdk`; the installed binary is still `mflow`.

```bash
npm i -g mflow-sdk
mflow --help
```

Do not treat hosted account login as available yet. The current public and self-hosted flows use a room name plus a strong shared secret. Hosted account/device authorization is planned for a future hosted product.

## What mflow is

- A local daemon that watches project files and syncs changes with peers in the same room.
- A WebSocket relay protocol for peer discovery and encrypted payload forwarding.
- A CLI for start/stop/status/pause/resume/file-lock workflows.
- A small MCP package for harness integrations.
- A self-hostable signaling server for Bun, Docker, and Deno Deploy.

## What mflow is not

- Not a git replacement. Git remains the source of truth for history and review.
- Not a cloud IDE. Files remain local on every peer.
- Not an account system in the current OSS release.
- Not a production SLA when using the public fair-use relay.
- Not a secret manager. You must generate and share strong room secrets safely.

## Quick start

### 1. Install

```bash
npm i -g mflow-sdk
```

### 2. Start a room in the first worktree

```bash
export MFLOW_SECRET="$(openssl rand -hex 32)"
mflow start --room my-project/main --secret "$MFLOW_SECRET"
```

If you omit `--secret`, mflow generates one and prints it once. Treat it like a password.

### 3. Join from another worktree or machine

```bash
mflow start --room my-project/main --secret "$MFLOW_SECRET"
```

Both peers must use the same room and secret. The public relay is used by default:

```text
wss://mflow-signal.obed0101.deno.net
```

### 4. Check status

```bash
mflow status
mflow status --watch
```

### 5. Pause around git operations

```bash
mflow pause
git add .
git commit -m "your change"
mflow resume
```

### 6. Stop

```bash
mflow stop
```

## CLI basics

```text
mflow start [options]       Start sync daemon and join a room
mflow stop                  Stop sync daemon and persist state
mflow status [--watch]      Show peers, files, locks, and sync stats
mflow pause                 Pause outgoing sync while continuing to receive
mflow resume [--force]      Resume sync and apply buffered changes
mflow lock <path>           Acquire a short file lock
mflow unlock <path>         Release a file lock
mflow locks                 List active file locks
mflow ignore <pattern>      Add a pattern to .mflowignore
mflow init                  Initialize .mflow config files
```

Common start options:

```bash
mflow start \
  --room my-project/main \
  --secret "$MFLOW_SECRET" \
  --signaling wss://mflow-signal.obed0101.deno.net \
  --transport relay
```

`--transport relay` is the default. `--transport p2p` exists for direct WebRTC-style transport experiments, but the relay path is the public-ready default.

## Public relay limits

The shared public relay is a free fair-use service intended for demos, onboarding, and small agent swarms. Current default limits are:

| Limit | Default |
|---|---:|
| Peers per room | 4 |
| Max WebSocket message | 65,536 bytes |
| Messages per minute per IP | 120 |
| Join attempts per minute per IP | 10 |
| Rate-limit violations before disconnect | 3 |
| Unauthenticated sockets per IP | 5 |
| Unauthenticated sockets globally | 500 |
| Active rooms | 200 |
| Idle room TTL | 15 minutes |
| Activity entries per room | 20 |

Need more capacity, privacy, or reliability? Self-host the relay and set your own limits.

## Self-hosting

Self-hosting keeps the same CLI model: room + secret, no account required.

```bash
mflow start \
  --room my-project/main \
  --secret "$MFLOW_SECRET" \
  --signaling ws://localhost:8787
```

Guides:

- [Self-hosting overview](./docs/self-hosting.md)
- [Deno Deploy](./docs/deno-deploy.md)
- [Bun + Docker](./docs/bun-docker.md)
- [Relay limits](./docs/limits.md)

## Security model

mflow uses a room secret for room admission and local key derivation. The relay receives a SHA-256 auth hash for room join checks and forwards encrypted payloads. Use high-entropy secrets and share them out of band.

Read the full [security model](./docs/security-model.md).

## Harness guides

- [Codex](./docs/harnesses/codex.md)
- [Claude Code](./docs/harnesses/claude-code.md)
- [opencode](./docs/harnesses/opencode.md)
- [Custom CLI or agent harness](./docs/harnesses/custom-cli.md)

## Development

```bash
bun install
bunx tsc --noEmit
bun test
scripts/check-public-release.sh
npm pack --dry-run
```

Package layout:

```text
packages/shared      Shared types, schemas, crypto, constants
packages/daemon      File watcher, CRDT sync, IPC, transports
packages/cli         mflow CLI and daemon launcher
packages/signaling   Bun relay, Deno Deploy relay, landing/dashboard
packages/mcp         MCP integration package
```

## Release and contribution

- License: MIT
- Security policy: [SECURITY.md](./SECURITY.md)
- Contribution guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Release process: [docs/release-process.md](./docs/release-process.md)
- Hosted auth roadmap: [docs/hosted-auth.md](./docs/hosted-auth.md)

Before publishing, re-check npm package names and inspect `npm pack --dry-run`. Do not publish from a dirty or unreviewed worktree.

## Hosted account/device login roadmap

Future hosted mflow may add GitHub OAuth with CLI device authorization:

```text
mflow login
Open: https://github.com/login/device
Code: ABCD-EFGH
Waiting for approval...
```

The hosted dashboard can be gated with GitHub device sign-in by setting `MFLOW_REQUIRE_DASHBOARD_AUTH=true` and configuring a GitHub App client ID. This protects dashboard/API room status only. The sync protocol still uses room + secret. Self-hosted mflow can remain usable without hosted accounts. A future self-hosted admin mode may support local email/password through explicit environment configuration.
