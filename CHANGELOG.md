# Changelog

All notable changes to mflow will be documented in this file.

This project follows a simple public release format. Dates use ISO format.

## [0.1.0] - 2026-05-06

Initial public OSS preparation release candidate.

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
- Hosted auth roadmap documentation for future GitHub OAuth/device authorization and future opt-in self-hosted local auth.

### Changed

- Root package name is `mflow-sdk`; the CLI binary remains `mflow`.
- Default CLI config now uses `wss://mflow-signal.obed0101.deno.net` instead of the previous placeholder relay URL.
- Public docs now separate current OSS/self-host room-secret mode from future hosted account/device login.

### Security

- Public relay now enforces conservative limits for peers, messages, joins, unauthenticated sockets, active rooms, idle cleanup, and activity retention.
- Docs warn that room secrets must be high entropy and shared out of band.
- `npm pack --dry-run` excludes local runtime state and agent/private scaffolding.

### Not included

- Hosted account login is not implemented.
- `mflow login`, `mflow logout`, and `mflow whoami` are planned/future only.
- No package has been published yet.
