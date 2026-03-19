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

Mflow syncs file changes in real-time between AI coding agents (Claude Code, Cursor, Codex, Cline) and human developers working on the same codebase. It uses CRDTs (Y.js) to merge concurrent edits without conflicts, encrypted end-to-end.

Think of it as **Google Docs for code repos** -- P2P, git-aware, and designed for multi-agent workflows.

### The Problem

Developers running 3-6+ AI agents in parallel hit the same wall: each agent works in its own worktree or branch, completely blind to the others. When they finish, merge conflicts are inevitable.

Mflow eliminates this by syncing file changes **before git commit** -- every participant sees every change as it happens.

### What Mflow Is NOT

- Not a git replacement -- git remains the source of truth for version history
- Not a cloud IDE -- your code stays on your machine
- Not a merge tool -- it prevents conflicts instead of resolving them
- Not a CI/CD tool -- it's a live collaboration layer

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/Obed0101/mflow.git
cd mflow
bun install

# Start syncing in your project directory
bun packages/cli/src/index.ts start --room my-project --secret my-shared-secret

# On another machine or worktree, join the same room
bun packages/cli/src/index.ts start --room my-project --secret my-shared-secret
```

Any file change in one directory appears in the other within seconds. No signaling server setup needed -- the public server at `wss://mflow-signal.obed0101.deno.net` is the default.

---

## How It Works

```
Agent A saves auth.ts
  -> chokidar detects the change
  -> fast-diff computes a minimal character-level delta
  -> Delta applied to Y.js CRDT document (conflict-free merge)
  -> CRDT update encrypted with AES-256-GCM (shared room secret)
  -> Encrypted bytes sent to signaling server (WebSocket relay)
  -> Signaling server forwards bytes to Peer B (never reads them)
  -> Peer B decrypts, applies CRDT merge (automatic, no conflicts)
  -> Merged content written to Peer B's filesystem
  -> Total latency: ~200-500ms on same network
```

### Architecture

```
Your Machine                    Deno Deploy                    Their Machine
+--------------+                +-----------+                  +--------------+
|  mflow       |   encrypted    | Signaling |   encrypted      |  mflow       |
|  daemon      |====websocket==>|  Server   |===websocket====> |  daemon      |
|              |                | (relay)   |                  |              |
|  watches     |                | never     |                  |  writes      |
|  files       |                | reads     |                  |  files       |
|  via         |                | your      |                  |  from        |
|  chokidar    |                | code      |                  |  CRDT        |
+--------------+                +-----------+                  +--------------+
```

The signaling server is a **dumb pipe** -- it relays encrypted bytes between peers. It cannot read your code, file names, or any content. All encryption happens locally on your machine before anything leaves.

### Monorepo Structure

```
packages/
  shared/      Types, crypto (AES-256-GCM), diff engine, ignore parser, Zod schemas
  signaling/   WebSocket relay server (Bun + Deno Deploy versions)
  daemon/      CRDT manager, file watcher, transport, sync orchestrator, IPC
  cli/         CLI commands (start, stop, status, pause, resume, ignore, init)
  mcp/         MCP server for AI agent integration
```

---

## Relationship with Git

Mflow sits **above git**, not beside or below it. Understanding this relationship is important.

### What Mflow Uses from Git

| Git Feature | How Mflow Uses It |
|-------------|-------------------|
| `.gitignore` | Mflow reads it and excludes matching files from sync |
| `git remote` URL | Auto-generates a room ID from `SHA-256(remote:branch)` |
| `.git/index.lock` | Detects git operations (commit, rebase, merge) and pauses sync |
| `.git/HEAD` | Reads current branch name for room ID generation |
| `.git/config` | Reads remote URL |

### What Mflow Does NOT Do with Git

- Does not run `git commit`, `git push`, `git pull`, or any git command
- Does not modify `.git/` directory in any way
- Does not require git authentication (no SSH keys, no tokens, no passwords)
- Does not need `git config user.name` or `user.email`
- Does not need `gh` CLI
- Does not create branches, tags, or PRs
- Does not interact with GitHub, GitLab, or any git hosting

### Git Config Requirements

**None.** Mflow works in any directory, git repo or not.

If you're in a git repo, Mflow reads `.gitignore` and the remote URL for convenience. If you're not in a git repo, Mflow still works -- you just need to pass `--room` manually.

```bash
# In a git repo (room auto-detected from remote + branch)
mflow start --secret my-secret

# Not a git repo (room specified manually)
mflow start --room my-room --secret my-secret
```

### The `gh` CLI

Mflow has **zero interaction** with the `gh` (GitHub CLI) tool. It doesn't use GitHub's API, doesn't create issues or PRs, and doesn't need any GitHub authentication.

### Typical Workflow

```bash
# 1. Start mflow in your project
mflow start --room feature-auth --secret team-secret-123

# 2. Work normally -- edit files, run tests, etc.
#    All changes sync to peers in real-time

# 3. When ready to commit, pause sync
mflow pause
git add .
git commit -m "feat: implement auth"
git push

# 4. Resume sync
mflow resume

# 5. When done for the day
mflow stop
```

---

## CLI Reference

```
mflow start [options]     Start sync daemon and join a room
  -r, --room <name>       Room name (default: derived from git remote + branch)
  -s, --secret <key>      Shared encryption secret (auto-generated if omitted)
  --signaling <url>       Signaling server URL (default: wss://mflow-signal.obed0101.deno.net)
  -t, --transport <type>  Transport: relay (default) or p2p

mflow stop                Stop daemon, persist CRDT state, cleanup
mflow status              Show room, peers, files tracked, sync stats, active pauses
mflow pause               Pause outgoing sync (keeps receiving + buffering changes)
mflow resume              Resume sync and apply buffered changes
mflow resume --force      Force-resume (admin override — clears ALL pause reasons)
mflow ignore <pattern>    Add gitignore-style pattern to .mflowignore
mflow init                Initialize .mflow/ directory with default config
```

### Examples

```bash
# Start with auto-generated room and secret
mflow start
# Output: Generated secret -- share with peers:
#   a1b2c3d4e5f6...

# Start with explicit room and secret
mflow start --room my-team/feature-x --secret "correct horse battery staple"

# Check who's connected
mflow status

# Temporarily stop syncing during a big refactor
mflow pause
# ... do work ...
mflow resume

# Exclude test output from sync
mflow ignore "*.test.output"
mflow ignore "coverage/"
```

---

## Configuration

### `.mflow/config.toml`

Created automatically on first `mflow start` or manually via `mflow init`.

```toml
[daemon]
name = ""                # Peer display name (default: hostname-PID)
type = "auto"            # "agent" | "human" | "auto"

[sync]
signaling = "wss://mflow-signal.obed0101.deno.net"
debounce_ms = 50                 # Batch rapid file saves
max_file_size_bytes = 1048576    # 1MB -- files larger are skipped
max_tracked_files = 5000         # Warn at 4000, hard limit at 5000
unload_after_minutes = 5         # Unload idle CRDT docs from memory

[sync.ignore]
patterns = [
  "node_modules", ".env*", "*.lock",
  "dist/", "build/", ".git/", ".mflow/"
]

[awareness]
broadcast_interval_ms = 5000     # How often to broadcast peer activity
share_current_file = true        # Show peers which file you're editing

[transport]
stun_servers = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"]
reconnect_max_delay_ms = 30000   # Max reconnect backoff
```

### `.mflowignore`

Gitignore-style patterns for files to exclude from sync (in addition to `.gitignore`).

```gitignore
# Auto-generated from .gitignore on init
node_modules/
dist/
.env*

# Custom mflow ignores
*.log
tmp/
```

### File Exclusion Rules

Files are excluded from sync if ANY of these apply:

| Rule | Example |
|------|---------|
| Matches `.gitignore` | `node_modules/`, `dist/` |
| Matches `.mflowignore` | Custom patterns |
| Matches default patterns | `.git/`, `.mflow/`, `.agents/`, `.env*` |
| File size > 1MB | Large binaries, data files |
| Binary file detected | `.png`, `.wasm`, `.zip`, etc. (null bytes in first 8KB) |
| Internal paths | `.git/*`, `.mflow/*` always blocked on remote writes |

---

## Security

### Encryption Model

All file content is encrypted **before leaving your machine**. The signaling server and any network observer sees only encrypted bytes.

```
Secret: "my-shared-secret"
  |
  +-> SHA-256(secret) = authHash        -> sent to signaling for room auth
  |                                        (server never sees the secret itself)
  |
  +-> HKDF(secret, salt=roomId,         -> AES-256-GCM encryption key
       info="mflow-enc", 256 bits)         (derived locally, never transmitted)

Every message:
  Plaintext (CRDT update)
  + Nonce (96-bit: peerId prefix + monotonic counter)
  + AAD (roomId:fileId:peerId)
  -> AES-256-GCM encrypt
  -> Only ciphertext leaves your machine
```

### What the Signaling Server Sees

| Data | Visible to Server? |
|------|-------------------|
| File contents | No -- encrypted |
| File names | No -- encrypted inside payload |
| Room ID | Yes -- needed for routing |
| Secret hash | Yes -- SHA-256 hash for auth (not the secret) |
| Peer names | Yes -- for peer discovery |
| Peer IPs | Yes -- WebSocket connections |
| Encrypted bytes | Yes -- but cannot decrypt them |

### What the Signaling Server Cannot Do

- Read your code (AES-256-GCM encrypted)
- Decrypt messages (doesn't have the secret)
- Modify messages without detection (GCM authentication tag)
- Replay old messages (monotonic nonce counters)
- Join your room (doesn't know the secret)
- Store your data (all in-memory, no persistence)

### Protections Against Malicious Peers

A peer who knows the room secret is trusted to participate. However, Mflow still protects against:

| Attack | Protection |
|--------|-----------|
| Path traversal (`../../etc/passwd`) | Path validation + `realpath()` symlink check |
| Write to `.git/`, `.mflow/` | Internal path blocklist on remote writes |
| Oversized files | 1MB file size limit enforced on remote writes |
| File count flood | 5000 tracked files limit |
| Memory exhaustion | Bounded pause buffer (1000 items / 50MB) |
| Nonce forgery | Nonce prefix verified against sender identity |
| Message replay | Strictly-increasing counter per peer |
| Daemon crash via malformed data | Full try/catch on all frame parsing |

### Signaling Server Hardening

| Protection | Detail |
|-----------|--------|
| Rate limiting | 10 joins/min, 100 messages/min per IP |
| Brute-force lockout | Exponential backoff after 3 failed auth attempts |
| Message size limit | 64KB max WebSocket payload |
| Connection exhaustion | 10s join timeout, 5 unauthenticated/IP, 500 global cap |
| Duplicate peer rejection | Cannot hijack another peer's session |
| IP trust | `X-Forwarded-For` only trusted when `TRUST_PROXY=true` |

### Recommendations

- **Always use auto-generated secrets** (32-byte random hex). Weak human-chosen secrets can be brute-forced offline.
- **Self-host the signaling server** if you need maximum privacy (see below).
- **Don't commit `.mflow/`** to git (auto-added to `.gitignore` by `mflow init`).

---

## Transport Modes

### Relay (default)

Messages routed through the signaling server. E2E encrypted -- server is a dumb pipe.

```bash
mflow start --room my-room --secret my-secret
# Uses wss://mflow-signal.obed0101.deno.net by default
```

Pros: Works across NAT, firewalls, any network. Zero config.
Cons: ~50-200ms added latency vs direct P2P.

### P2P (WebRTC)

Direct peer-to-peer via werift (pure TypeScript WebRTC). Signaling server only used for initial handshake.

```bash
mflow start --room my-room --secret my-secret --transport p2p
```

Pros: Lower latency on LAN. Code never touches any server.
Cons: May fail behind corporate firewalls or symmetric NAT.

---

## Pause/Resume: How It Handles Multiple Agents + Humans

When 3 AI agents and a human share a room, anyone can pause and resume at any time. Mflow handles this safely.

### The Short Version

Each pause creates a **reason** with a unique ID. Sync only resumes when **all reasons are cleared**. Nobody can accidentally undo someone else's pause.

### Example: Human + 2 Agents

```
1. Agent A pauses (doing a multi-file refactor)
   Active pauses: [ agent-a ]
   Status: PAUSED

2. Human pauses (about to git commit)
   Active pauses: [ agent-a, human ]
   Status: PAUSED

3. Agent A finishes, resumes
   Active pauses: [ human ]             ← agent-a's reason removed
   Status: STILL PAUSED                 ← human's reason still active

4. Agent B calls resume (doesn't know human is mid-commit)
   Active pauses: [ human ]             ← nothing happens, agent B had no pause
   Status: STILL PAUSED                 ← human is protected

5. Human finishes git commit, resumes
   Active pauses: [ ]                   ← all reasons cleared
   Status: SYNCING                      ← sync resumes, buffered changes applied
```

Key point: **Agent B's resume in step 4 does nothing** because Agent B never paused. You can only remove your own pause, not someone else's.

### Example: 5 Agents Working in Parallel

```
Agent A pauses:  pauses = { A }
Agent B pauses:  pauses = { A, B }
Agent C pauses:  pauses = { A, B, C }
Agent B resumes: pauses = { A, C }       ← only B's reason removed
Agent A resumes: pauses = { C }          ← only A's reason removed
Agent C resumes: pauses = { }            ← all clear, sync resumes
```

No conflicts. No races. Each agent manages its own pause independently.

### Who Can Override Whom?

| Who | Can unpause |
|-----|-------------|
| Human (CLI) | Only their own pauses. Or `--force` to clear everything. |
| AI Agent (MCP) | Only their own pauses. Cannot touch human or other agent pauses. |
| Git (auto) | Only git-related pauses. Cannot touch human or agent pauses. |

The human always has the final word via `mflow resume --force` (clears all pauses from all sources).

### Why This Matters

Without this model, a common disaster:

```
Human: mflow pause           ← preparing to git commit
Agent: mflow_resume           ← doesn't know, just wants sync back
       sync resumes!          ← files change during git commit
       git index corrupted    ← disaster
```

With the pause-reason model, the agent's resume **does nothing** because it has no active pause to remove. The human's pause is untouchable until the human explicitly resumes.

---

## MCP Server (AI Agent Integration)

Mflow includes an MCP server that lets AI agents query sync status and coordinate edits.

### Available Tools

| Tool | Description |
|------|-------------|
| `mflow_status` | Daemon state, peers, files tracked, ops/sec |
| `mflow_health` | Quick health check |
| `mflow_peers` | Connected peers with names and types |
| `mflow_pause` | Pause outgoing sync |
| `mflow_resume` | Resume sync |
| `mflow_stop` | Graceful daemon shutdown |
| `mflow_ignore` | Add ignore pattern at runtime |

### Claude Code Integration

Add to your `.claude/settings.json`:

```json
{
  "mcpServers": {
    "mflow": {
      "command": "bun",
      "args": ["run", "/path/to/mflow/packages/mcp/src/index.ts", "--root", "/path/to/your/project"]
    }
  }
}
```

Then Claude Code can call `mflow_status`, `mflow_peers`, etc. as native tools.

---

## Self-Hosted Signaling

If you don't want to use the public signaling server, run your own:

### Docker

```bash
docker build -t mflow-signaling packages/signaling/
docker run -p 8787:8787 mflow-signaling
```

### Direct (Bun)

```bash
PORT=8787 bun packages/signaling/src/index.ts
```

### Direct (Deno)

```bash
deno run --allow-net --allow-env packages/signaling/deno-deploy.ts
```

### Use Your Server

```bash
mflow start --signaling ws://your-server:8787 --room my-room --secret my-secret
```

Or set it in `.mflow/config.toml`:

```toml
[sync]
signaling = "wss://your-server.com"
```

Health check: `GET /health` returns `{"status":"ok","rooms":0,"peers":0,"uptime":123,"memoryMB":40}`

Resource usage: ~40-50MB RAM. Handles thousands of concurrent rooms on minimal hardware.

---

## Hosting Costs

The public signaling server runs on Deno Deploy's free tier:

| Resource | Free Limit | Mflow Usage |
|----------|-----------|-------------|
| Requests/month | 1,000,000 | Low (WebSocket upgrades only) |
| Bandwidth | 100 GB | Minimal (small JSON messages) |
| CPU time | 15 hours/month | Minimal (relay is O(1) per message) |
| Cost | **$0** | No credit card required |

The signaling server is stateless -- rooms exist only in memory while peers are connected. No database, no storage, no persistence.

---

## How CRDTs Prevent Conflicts

Mflow uses Y.js, a battle-tested CRDT (Conflict-free Replicated Data Type) library.

When two agents edit the same file simultaneously:

```
Agent A: adds "import { auth } from './auth';" at line 1
Agent B: adds "import { db } from './db';" at line 1

Traditional merge: CONFLICT -- both changed line 1
CRDT merge: Both imports are preserved (deterministic order)
```

CRDTs guarantee **convergence** -- all peers end up with the same content, regardless of edit order or network delays. There is no "conflict resolution" because conflicts are mathematically impossible at the text level.

**Important**: CRDTs guarantee text convergence, not semantic correctness. Two agents could both write valid code that together is broken. Mflow's awareness system shows who's editing what, so agents/developers can coordinate.

---

## Limits

| Resource | Limit |
|----------|-------|
| File size | 1 MB per file (configurable) |
| Tracked files | 5,000 per project (configurable) |
| Peers per room | 10 (signaling enforced) |
| Message size | 64 KB per WebSocket frame |
| CRDT doc memory | ~50-100 KB per active file |
| Total daemon memory | < 500 MB for 1000 files + 5 peers |

---

## Development

```bash
# Install dependencies
bun install

# Type check all packages
bun run typecheck

# Run all tests (127 tests)
bun test

# Run specific test suite
bun test tests/integration/crypto.test.ts
bun test tests/integration/signaling.test.ts
bun test tests/integration/edge-cases.test.ts

# Start local signaling server
bun run dev:signaling

# Run CLI directly
bun packages/cli/src/index.ts --help

# Run MCP server
bun packages/mcp/src/index.ts --root .
```

---

## Roadmap

- [ ] npm publish (`npx mflow start`)
- [ ] VS Code extension
- [ ] Web dashboard (rooms, peers, sync stats)
- [ ] Smart file locking (soft/hard locks)
- [ ] Branch awareness warnings
- [ ] Per-session encryption keys
- [ ] TURN relay fallback for P2P

---

## License

MIT
