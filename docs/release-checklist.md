# Release Checklist

Use this checklist before making a public GitHub release or publishing npm packages.

## Scope

- Current package target: `mflow-cli`.
- CLI binary: `mflow`.
- Current auth model: no account, room + secret.
- Hosted account/device login: planned/future only.
- Future hosted GitHub App credentials, if created, stay in local ignored env/secrets only.

## Required checks

```bash
git status --short
bunx tsc --noEmit
bun test
scripts/check-public-release.sh
npm pack --dry-run
npm view mflow name version description license repository --json || true
npm view mflow-cli name version description license repository --json || true
npm view @mflow/sdk name version description license repository --json || true
grep -RInE "(api[_-]?key|secret|token|password|BEGIN .*PRIVATE KEY|sk-|ghp_|github_pat_)" --exclude-dir=node_modules --exclude-dir=.git .
```

## npm name decision

As of the latest pre-release audit:

- `mflow` exists on npm and is not this project.
- `mflow-cli` is the intended public package name.
- `@mflow/sdk` returned 404, but scoped publish requires owning/configuring the npm scope.

Re-run the npm checks immediately before publish. Registry state can change.

## Secret scan triage

Expected non-blocking matches:

- tests with fake strings such as `test-secret`, `my-room-secret`, `shared-secret`.
- docs examples using `$MFLOW_SECRET` or `<shared-secret>` placeholders.
- `.agents/` internal specs and orchestration logs, which are ignored and excluded from npm pack.
- `.mflow/config.toml` local runtime state, ignored and excluded from npm pack.

Blocking matches:

- real API keys, access tokens, private keys, passwords, or account credentials.
- real GitHub App client secrets, private keys, or machine-local private key paths.
- unignored local config that would be tracked or packed.
- any secret-like value inside public docs that is not clearly fake or placeholder text.

## npm pack review

Inspect `npm pack --dry-run` output. It must include public docs/source needed by users and exclude:

- `.mflow/`
- `.agents/`
- `.claude/`
- `.mcp.json`
- `.env*`
- `*.tsbuildinfo`
- daemon PID/socket files
- CRDT state files
- temp files

## Publish gate

Do not publish until:

- all checks pass,
- npm name is re-verified,
- secret scan is triaged,
- pack contents are reviewed,
- changelog/version are final,
- release branch/PR is reviewed,
- no hosted-login availability claims exist.
