# Contributing to mflow

Thanks for helping improve mflow. This project is being prepared as an open-source, self-hostable developer tool for real-time code sync across AI agent worktrees.

## Development setup

```bash
git clone https://github.com/Obed0101/mflow.git
cd mflow
bun install
bunx tsc --noEmit
bun test
```

Do not commit local runtime state, generated daemon state, private tool configs, secrets, or machine-specific files.

## Branch naming

Use short, descriptive branches:

| Work type | Pattern | Example |
| --- | --- | --- |
| Feature | `feat/<topic>` | `feat/public-relay-limits` |
| Fix | `fix/<topic>` | `fix/deno-room-cap` |
| Docs | `docs/<topic>` | `docs/codex-setup` |
| Chore | `chore/<topic>` | `chore/release-hygiene` |
| Refactor | `refactor/<topic>` | `refactor/signaling-limits` |
| Security | `security/<private-id>` | `security/GHSA-xxxx` |
| Release | `release/vX.Y.Z` | `release/v0.1.0` |

## Pull requests

Open pull requests against `main`. Keep PRs focused and include:

- What changed.
- Why it changed.
- Test evidence, including exact commands run.
- CLI output or screenshots for user-facing changes.
- Public-release checklist impact when the change affects packaging, docs, relay limits, or security.

Before requesting review, run:

```bash
bunx tsc --noEmit
bun test
```

For release-sensitive changes, also run:

```bash
scripts/check-public-release.sh
npm pack --dry-run
```

## Coding standards

- Preserve existing public CLI commands and file formats unless the PR explicitly changes them.
- Keep the CLI scriptable; do not add mandatory interactive prompts.
- Keep hosted relay limits configurable and documented.
- Prefer small, readable changes over broad rewrites.
- Add or update tests for behavior changes.
- Do not include vendor or AI attribution fingerprints in commits, PR titles, changelog entries, or release notes.

## Security changes

Do not disclose exploit details in a public issue or PR. Follow `SECURITY.md` for private reporting. Maintainers should prepare fixes on a private security branch or advisory workflow and publish the patch and advisory together.

## Release workflow

Mflow uses a simple trunk-based OSS workflow:

1. Merge reviewed PRs into `main`.
2. Cut a short-lived `release/vX.Y.Z` branch.
3. Update versions and `CHANGELOG.md`.
4. Run typecheck, tests, public-release checks, secret scan, and `npm pack --dry-run`.
5. Tag `vX.Y.Z` after verification.
6. Publish the GitHub release.
7. Publish npm only after re-verifying the selected package name and inspecting package contents.

The initial public npm package name is planned as `mflow-sdk`, with the CLI binary remaining `mflow`. Re-check npm immediately before publishing; package availability can change.
