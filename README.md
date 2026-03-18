```
           ___  __
 _ __ ___ / _|| | _____      __
| '_ ` _ \| |_ | |/ _ \ \ /\ / /
| | | | | |  _|| | (_) \ V  V /
|_| |_| |_|_|  |_|\___/ \_/\_/
```

Real-time code sync for AI agent teams.

---

## What is Mflow?

Mflow syncs file changes in real-time between AI coding agents and human developers working on the same codebase. It uses CRDTs (Y.js) to merge concurrent edits without conflicts, encrypted end-to-end.

Think of it as Google Docs for code repos, but P2P and git-aware.

## Quick Start

```bash
# Terminal 1 — start the signaling server
bun packages/signaling/src/index.ts

# Terminal 2 — start syncing in your project
mflow start --room my-project --secret my-shared-secret

# Terminal 3 — join from another machine/worktree
mflow start --room my-project --secret my-shared-secret
```

Any file change in one directory appears in the other within seconds.

## How It Works

```
Agent A saves file.ts
  -> chokidar detects change
  -> fast-diff computes minimal delta
  -> Y.js CRDT operation created
  -> AES-256-GCM encrypted
  -> Sent to peer via signaling relay (or WebRTC P2P)
  -> Peer decrypts, applies CRDT merge
  -> Writes merged result to filesystem
  -> ~500ms total latency
```

Architecture:

```
packages/
  shared/      Types, crypto, diff engine, ignore parser
  signaling/   WebSocket server for peer discovery + relay
  daemon/      File watcher, CRDT manager, transport, sync engine
  cli/         User-facing commands
```

## CLI Reference

```
mflow start [options]     Start sync daemon and join a room
  --room <name>           Room name (default: derived from git)
  --secret <key>          Shared encryption secret
  --signaling <url>       Signaling server URL
  --transport <type>      Transport: relay (default) or p2p

mflow stop                Stop daemon and persist state
mflow status              Show peers, files, sync stats
mflow pause               Pause outgoing sync (keep receiving)
mflow resume              Resume sync
mflow ignore <pattern>    Add ignore pattern
mflow init                Initialize .mflow/ config
```

## Configuration

`.mflow/config.toml`:

```toml
[daemon]
name = ""
type = "auto"          # "agent" | "human" | "auto"

[sync]
signaling = "wss://signal.mflow.dev"
debounce_ms = 50
max_file_size_bytes = 1048576    # 1MB
max_tracked_files = 5000
unload_after_minutes = 5

[sync.ignore]
patterns = ["node_modules", ".env*", "*.lock", "dist/", "build/"]

[awareness]
broadcast_interval_ms = 5000
share_current_file = true

[transport]
stun_servers = ["stun:stun.l.google.com:19302"]
reconnect_max_delay_ms = 30000
```

Files matching `.gitignore` and `.mflowignore` are excluded automatically.

## Security

- All data encrypted with AES-256-GCM using a shared room secret
- Key derived via HKDF (SHA-256) from the secret
- 96-bit nonce: peer ID prefix + monotonic counter (no reuse)
- Replay protection via strictly-increasing nonce counters
- Signaling server never sees plaintext file content
- Room auth via SHA-256 hash of secret (server never stores the secret)

## Transport Modes

**Relay (default)**: Messages routed through signaling server, encrypted E2E. Works across NAT, firewalls, any network. Server is a dumb pipe.

**P2P** (`--transport p2p`): Direct WebRTC via werift (pure TypeScript). Lower latency on LAN. Requires STUN for NAT traversal.

## Self-Hosted Signaling

```bash
# Docker
docker build -t mflow-signaling packages/signaling/
docker run -p 8787:8787 mflow-signaling

# Direct
PORT=8787 bun packages/signaling/src/index.ts
```

Health check: `GET /health` returns room count, peer count, uptime.

Resource usage: ~50MB RAM for thousands of concurrent rooms.

## Development

```bash
bun install
bun test                           # Unit + integration tests
bun run typecheck                  # TypeScript strict mode
bun run dev:signaling              # Start signaling server
bun packages/cli/src/index.ts      # Run CLI directly
```

## License

MIT
