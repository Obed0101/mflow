# Roadmap

mflow is early OSS infrastructure for synchronized local worktrees. This roadmap is intentionally practical: keep the CLI useful, make the package install cleanly, and only add hosted features where they do not weaken self-hosted usage.

## Now

- CLI-first room + secret sync.
- Public fair-use relay.
- Self-hosted Bun/Docker/Deno Deploy relay.
- Dashboard status view and hosted settings/API keys.
- MCP control surface for status, peers, pause/resume, and locks.

## Next

- Harden npm packaging and install tests for every release.
- Improve MCP install UX for Codex, Claude Code, Cursor, opencode, and custom clients.
- Add stronger room-level dashboard views without exposing plaintext secrets.
- Add better conflict visualization around hot files.
- Add optional pre-commit helpers that pause/resume mflow safely.

## Later

- Hosted CLI account flow with GitHub Device Flow.
- Team-scoped hosted API keys and relay limits.
- Optional self-hosted admin mode, off by default.
- Rich file tree/diff views in dashboard room pages.
- More transport hardening and P2P experiments once relay mode stays boring.

## Non-goals

- Replacing git.
- Requiring hosted accounts for self-hosted sync.
- Storing room secrets server-side.
- Turning the relay into a cloud IDE.
