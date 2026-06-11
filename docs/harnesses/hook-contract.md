# Universal Hook Contract

Use this contract when wiring mflow into any agent harness, editor adapter, or custom CLI. The goal is consistent behavior before filesystem writes, not harness-specific magic.

## Scope

This contract applies to:

- single-file writes
- multi-file edits
- patch application
- broad assignment claims
- git operations that can race with sync

## Required lifecycle

1. Resolve the repository root.
2. Normalize all target paths relative to that root.
3. Refuse paths outside the project root.
4. Acquire mflow coordination before writing:
   - single hot file: `mflow lock <path> --wait --timeout 60s`
   - broad scope: `mflow claim "<glob>" --timeout 2m`
   - patch payload: prefer `mflow apply-patch <patch-file>`
5. If acquisition fails, deny or abort the edit instead of writing anyway.
6. Around `commit`, `rebase`, `reset`, or destructive rewrites: `mflow pause`, perform the git operation, then `mflow resume`.
7. Never print room secrets.

## Minimal adapter surface

A harness adapter should provide these phases:

- `beforeEdit(paths[])`
- `beforePatch(patchText)`
- `beforeGitOperation(kind)`
- `afterEdit(result)`

Suggested mapping:

- `beforeEdit(paths[])` -> acquire per-file locks
- `beforePatch(patchText)` -> extract file targets or delegate to `mflow apply-patch`
- `beforeGitOperation(kind)` -> `mflow pause`
- `afterEdit(result)` -> optional cleanup, telemetry, or lock-release policy

## Required path rules

- Normalize absolute and relative paths against the repo root.
- Reject any path that resolves outside the repo root.
- Deduplicate paths before locking.
- Preserve case and exact relative path spelling after normalization.

## Recommended environment variables

- `MFLOW_BIN`
- `MFLOW_LOCK_DURATION`
- `MFLOW_LOCK_TIMEOUT`
- `MFLOW_LOCK_PRIORITY`

## Human approval rule

Agents should not install or modify harness integrations silently.

Expected flow:

1. run `mflow hook-status`
2. explain what is missing
3. ask the human for approval
4. if approved, install or update the harness adapter
5. otherwise continue with manual mflow coordination

## Codex note

Codex support may require build-specific wiring. If a repo ships a Codex scaffold, treat it as experimental until the current Codex build has been verified with real edit interception tests.
