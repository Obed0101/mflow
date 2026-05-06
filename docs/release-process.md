# Release Process

Mflow is being prepared for public OSS distribution. Do not publish npm packages or make release claims until every check below has passed in the release branch.

## Package naming

The initial public npm package is planned as `mflow-sdk`, with the CLI binary named `mflow`.

Before publishing, re-check registry state:

```bash
npm view mflow name version description license repository --json || true
npm view mflow-sdk name version description license repository --json || true
npm view @mflow/sdk name version description license repository --json || true
```

Do not publish as `mflow` unless ownership is acquired or the current package owner transfers the name.

## Release branch flow

1. Ensure `main` is releasable.
2. Create `release/vX.Y.Z`.
3. Update versions and `CHANGELOG.md`.
4. Run verification:

```bash
bunx tsc --noEmit
bun test
scripts/check-public-release.sh
npm pack --dry-run
grep -RInE "(api[_-]?key|secret|token|password|BEGIN .*PRIVATE KEY|sk-|ghp_|github_pat_)" --exclude-dir=node_modules --exclude-dir=.git .
```

5. Triage secret-scan matches. Tests and docs may contain fake examples; real credentials block release.
6. Inspect package contents from `npm pack --dry-run`.
7. Tag `vX.Y.Z`.
8. Publish GitHub release.
9. Publish npm package only after final registry and package-content checks.

## Forbidden public artifacts

The public release must not include:

- `.mflow/`
- `.agents/`
- `.claude/`
- `.mcp.json`
- `.env` or `.env.*` files, except `.env.example`
- `*.tsbuildinfo`
- `*.tmp`
- `*.bun-build`
- daemon PID/socket files
- CRDT state files such as `*.ystate`
- machine-local settings or secrets
