# Changelog

All notable changes to mflow will be documented in this file.

This project follows a simple public release format. Dates use ISO format.

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
