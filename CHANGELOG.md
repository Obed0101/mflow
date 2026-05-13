# Changelog

All notable changes to mflow will be documented in this file.

This project follows a simple public release format. Dates use ISO format.

## [0.1.11] - 2026-05-12

### Changed

- Reduced npm package contents to the CLI/MCP runtime files only so optional relay dashboard assets and documentation URLs are not shipped in the install tarball.
- Removed default STUN server strings while P2P transport is disabled.

## [0.1.10] - 2026-05-12

### Added

- Added queued locks with `--wait`, `--timeout`, and `--priority`, including FIFO ordering within priority.
- Added `mflow install-hooks` for project-local Claude Code and OpenCode pre-edit lock adapters.
- Added `mflow apply-patch` and MCP `mflow_apply_patch` to apply Codex-style patches under queued file locks.
- Added `mflow claim` for cooperative scope reservations.

### Fixed

- Removed the experimental WebRTC/P2P runtime dependency from the public package because its upstream dependency chain still pulled a high-severity vulnerable `ip` package.
- Shared the daemon lock manager with the sync orchestrator so CLI/MCP locks affect propagation gating.
- Added polling fallback to `GitDetector` so `.git/index.lock` transitions are detected when `fs.watch` misses temp-directory events.
- Updated signaling integration tests to avoid `Bun.serve({ port: 0 })`, which fails under Bun 1.3.13 in this environment.

## [0.1.9] - 2026-05-07

README onboarding and dashboard card cleanup.

### Changed

- README now leads with the real first-time CLI flow: `mflow setup`, `mflow start`, `mflow status`, `mflow status --watch`, `mflow secret --copy`, `mflow pause`, `mflow resume`, and `mflow stop`.
- Removed the old duplicate quick-start block that assumed users already understood room/secret setup.
- Dashboard stats card now shows relay memory usage instead of misleading instance uptime.

## [0.1.7] - 2026-05-07

Dashboard room-state and streamer safety patch.

### Fixed

- Dashboard now validates secret before entering room mode; invalid/empty room no longer appears as a successful room connect.
- Dashboard now writes `?room=<roomId>` immediately after a successful connect and stores session per-room.
- If a connected room disappears (for example after `mflow stop`), dashboard now exits room mode back to home with a `Room disconnected` message.
- `mflow start` once again prints dashboard/monitor/stop/secret hints when the daemon is already running instead of dropping straight to a bare status snapshot.
- Daemon sync state now keeps polling transport connectivity so stale relay disconnects are reflected as reconnecting/connecting instead of staying stuck on `syncing`.

### Changed

- Added `mflow start --copy-secret` to copy generated room secret to clipboard for safer on-stream workflows.

## [0.1.6] - 2026-05-07

Dashboard persistence and activity visibility patch.

### Fixed

- Fixed hosted dashboard room monitor persistence so refreshes keep the room-scoped session by storing only the `secretHash` in session storage.
- Fixed the CLI/TUI status views to show real recent file activity instead of always falling back to "waiting for activity".

### Changed

- `mflow start`, `mflow status`, and no-args help now explain how to open the hosted dashboard, reuse the same room secret, and stop the local daemon with `mflow stop`.
- Hosted dashboard room view now renders basic file tree and changed-files panels from recent room activity instead of placeholder copy.

## [0.1.5] - 2026-05-07

Daemon startup and setup UX patch.

### Fixed

- Fixed `mflow start` writing a PID file before the daemon finished booting, which caused self-inflicted stale/duplicate daemon failures and left hosted relay rooms at `0`.
- Fixed `mflow start` to wait for real daemon readiness before printing success, and to surface `.mflow/daemon.log` context when startup fails.

### Changed

- `mflow setup` now uses clearer numbered choices for hosted vs self-hosted relay and yes/no decisions.
- `mflow setup` now explains that the hosted dashboard API key comes from `/settings`, is optional, and can be skipped for normal room+secret sync.

## [0.1.4] - 2026-05-07

Hotfix release for the setup flow.

### Fixed

- Fixed `mflow setup` crashing with `projectRoot is not defined`.

## [0.1.3] - 2026-05-07

CLI polish patch.

### Fixed

- Replaced the broken ASCII banner with a readable `mflow` banner.
- `mflow setup` no longer prints local absolute paths in the MCP command; it uses `--root .`.

### Changed

- `mflow setup` now derives the default room name from the current directory and explains what the room name is for.

## [0.1.2] - 2026-05-07

Rename and setup release for the public CLI package.

### Fixed

- Corrected one-shot MCP setup commands to use `bunx -p mflow-cli mflow-mcp` because the npm package is `mflow-cli` and the binary is `mflow-mcp`.
- `mflow start` now honors room, secret, and signaling values from `.mflow/config.toml`.

### Added

- Added explicit AI-agent guidance: agents must ask the human/project owner before installing, starting, or configuring mflow, MCP, or the portable skill.
- Added `mflow setup`, a guided CLI setup for room, relay, secrets, optional hosted dashboard API key, and MCP command discovery.

### Changed

- Renamed the npm package from `mflow-sdk` to `mflow-cli`; the installed binaries remain `mflow` and `mflow-mcp`.

## [0.1.1] - 2026-05-07

Patch release after the first npm publish.

### Fixed

- Fixed npm runtime packaging so the published `mflow` and `mflow-mcp` binaries can resolve dependencies outside the monorepo workspace.
- Added root runtime dependencies required by the published package.

### Added

- Published `mflow-mcp` binary for MCP clients.
- Added a portable agent skill at `skills/mflow/SKILL.md` with pause/resume/lock rules for safe AI-agent operation.
- Added Cursor harness guide, harness index, and roadmap docs.

### Changed

- README is now compact, uses collapsible MCP setup sections, and documents Codex, Claude Code, Cursor, opencode, and custom MCP clients.
- README now explains what happens if an agent forgets to pause before git operations.

## [0.1.0] - 2026-05-06

Initial public OSS release.

### Added

- MIT license, security policy, contribution guide, PR template, and issue templates.
- Public release hygiene script: `scripts/check-public-release.sh`.
- `.npmignore` and package `files` allowlist for safer npm packing.
- Public relay limit configuration for Bun signaling and Deno Deploy.
- Deno Deploy self-contained signaling relay at `packages/signaling/deno-deploy.ts`.
- Landing page copy for no-account room-secret usage, public fair-use limits, dashboard, and self-hosting.
- CLI UX polish: ASCII banner, grouped help, no-args guidance, `NO_COLOR`-safe display, and richer `mflow start` summary.
- CLI UX integration tests.
- Public documentation: quickstart, troubleshooting, limits, self-hosting, Deno Deploy, Bun/Docker, security model, and harness guides for Codex, Claude Code, opencode, and custom CLIs.
- Hosted dashboard auth documentation for GitHub OAuth and future CLI device authorization.

### Changed

- Root package name is `mflow-cli`; the CLI binary remains `mflow`.
- Default CLI config now uses `wss://mflow-signal.obed0101.deno.net` instead of the previous placeholder relay URL.
- Public docs now separate current OSS/self-host room-secret mode from future hosted account/device login.

### Security

- Public relay now enforces conservative limits for peers, messages, joins, unauthenticated sockets, active rooms, idle cleanup, and activity retention.
- Docs warn that room secrets must be high entropy and shared out of band.
- `npm pack --dry-run` excludes local runtime state and agent/private scaffolding.

### Known issue

- The initial `0.1.0` npm package did not resolve monorepo workspace runtime dependencies correctly when installed outside this repository. Use `0.1.1` or later.
