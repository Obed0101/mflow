# MendCode Integration Request

Status: mflow-side support shipped in `mflow-cli@0.1.12` as a repo-local experimental MendCode scaffold. The first-class MendCode UI/control still needs MendCode-side implementation.

This document is the implementation brief for a first-class MendCode integration. The current mflow baseline already provides CLI sync, MCP controls, queued locks, `claim`, `apply-patch`, and experimental harness adapters. MendCode should expose those capabilities as an explicit user-controlled feature instead of relying on manual setup.

## Implemented in this repo

mflow now ships MendCode as a selectable harness scaffold in `mflow-cli@0.1.12` and newer:

```bash
pnpm --package=mflow-cli@latest dlx mflow install-hooks --harness mendcode
pnpm --package=mflow-cli@latest dlx mflow hook-status --harness mendcode
```

For an already installed global CLI:

```bash
mflow install-hooks --harness mendcode
mflow hook-status --harness mendcode
```

`install-hooks --harness mendcode` writes:

- `.mendcode/plugins/mflow-lock.js` — experimental `tool.execute.before` adapter that extracts edit/write/multiedit/apply-patch targets and runs queued locks before the write.
- `.mendcode/mflow-control.md` — the MendCode-side activation/control contract, public relay warning copy, pnpm MCP command shape, and manual lock/claim/apply-patch guidance.
- `.mendcode/mcp.mflow.example.json` — MCP server config example using `pnpm --package=mflow-cli dlx mflow-mcp --root /absolute/path/to/repo`.

`hook-status --harness mendcode` reports whether that scaffold is present and explicitly states that MendCode UI toggle and real hook verification remain MendCode-side work. It does not claim the MendCode-side hook is verified.

## Current mflow baseline

- CLI package: `mflow-cli`; installed binary: `mflow`.
- Hosted public relay: `https://mflow-signal.obed0101.deno.net/`.
- Public relay limits: fair-use only, currently documented as 4 peers per room, 64 KB max message size, rate limits, idle cleanup, and bounded dashboard activity.
- Self-hosting is supported through a custom signaling URL.
- Locks support queueing with `--wait`, `--timeout`, and `--priority`.
- MCP server exposes status, peers, pause/resume, and locks.
- Harness docs already define a universal pre-edit contract in `docs/harnesses/hook-contract.md`.

## Desired MendCode UX

MendCode should let the user toggle mflow from inside MendCode:

1. User opens the mflow control.
2. MendCode shows whether mflow is disabled, enabled but stopped, or running.
3. If disabled, the user can activate it.
4. Activation asks which relay to use:
   - Public relay: `https://mflow-signal.obed0101.deno.net/`.
   - Custom/self-hosted relay URL.
5. If public relay is selected, MendCode must clearly say it is restricted/fair-use and not intended for large rooms or production reliability.
6. MendCode asks for or generates:
   - room name
   - room secret
   - whether to store the room secret locally
7. MendCode configures the local user/repo so future MendCode agents can use mflow.
8. User can deactivate mflow without deleting the room config.
9. User can remove local mflow config intentionally as a separate destructive action.

The mflow repo cannot implement this UI directly because MendCode's product/runtime code is outside this repository. The scaffold above provides the files, command shapes, and adapter contract for the MendCode implementation.

## Package manager requirement

MendCode setup must use pnpm, not npm.

Acceptable command shapes:

```bash
pnpm add -g mflow-cli
pnpm --package=mflow-cli dlx mflow setup
pnpm --package=mflow-cli dlx mflow-mcp --root /absolute/path/to/repo
```

Avoid documenting or running `npm install`, `npm i -g`, or npm-based MCP commands in the MendCode flow.

## MendCode configuration target

The integration should configure MCP for the active MendCode user/repo with the mflow MCP server:

```bash
mend mcp add mflow -- pnpm --package=mflow-cli dlx mflow-mcp --root /absolute/path/to/repo
```

If the actual MendCode command differs, the MendCode implementation should use the repo-native MCP config API instead of shelling out. The important contract is:

- command: `pnpm`
- args: `["--package=mflow-cli", "dlx", "mflow-mcp", "--root", "<repo>"]`
- root: active project/worktree root
- no plaintext room secret in prompts, logs, commits, or screenshots

## Hook / pre-edit behavior

MendCode should enforce queued locks before local writes when mflow is enabled.

Desired lifecycle:

1. At session start, check mflow status and active locks.
2. Show the agent/user which files are currently blocked or queued.
3. Before an agent edits a file, check whether the file is locked.
4. If the file is free, acquire a queued lock:

```bash
mflow lock path/to/file --duration 30s --wait --timeout 60s --priority 0
```

5. If the file is blocked, ask to queue with priority instead of editing anyway.
6. For broad work, reserve scope first:

```bash
mflow claim "src/**" --timeout 2m --priority 0
```

7. For patch-heavy Codex-style edits, prefer:

```bash
mflow apply-patch patch.txt --timeout 60s --priority 0
```

8. Around commit/rebase/reset, pause mflow before the git operation and resume afterward.

MendCode appears to have a plugin-style `tool.execute.before` path, so the first adapter should investigate whether the existing opencode plugin scaffold can be reused. Do not mark hook support as verified until real file-write interception is tested with the active MendCode build.

The repo-local scaffold reuses the same queued-lock strategy as the opencode adapter, adapted for likely MendCode tool argument names. It is intentionally marked experimental until tested against a real MendCode write path.

## Public relay warning copy

Use copy like this when the public relay is selected:

```text
Public mflow relay is a shared fair-use service. It is good for demos, small swarms, and onboarding. It has peer, message, rate, active-room, idle-timeout, and dashboard-history limits. For larger teams, private code, production reliability, or custom limits, use a self-hosted mflow relay URL.
```

## Acceptance criteria

- MendCode has an explicit mflow on/off control.
- Enabling mflow asks for public relay vs custom URL.
- Public relay selection shows the fair-use restriction warning.
- Setup uses pnpm command shapes only.
- MCP is configured for the active MendCode repo/user.
- Session start can report current locks.
- Pre-edit enforcement queues or denies writes when locks cannot be acquired.
- Queue priority is supported.
- Secrets are never printed.
- Deactivation stops mflow use without silently deleting config.
- README links this MendCode guide.

## Current status against acceptance criteria

| Criterion | Status | Notes |
|---|---|---|
| MendCode has an explicit mflow on/off control. | Pending in MendCode | Requires MendCode UI/runtime code. |
| Enabling mflow asks for public relay vs custom URL. | Pending in MendCode | Contract documented in `.mendcode/mflow-control.md` scaffold. |
| Public relay selection shows the fair-use restriction warning. | Ready for MendCode | Warning copy is included in this guide and generated control guide. |
| Setup uses pnpm command shapes only. | Implemented for MendCode scaffold/docs | Generated MCP example uses `pnpm --package=mflow-cli dlx`. |
| MCP is configured for the active MendCode repo/user. | Pending in MendCode | Scaffold provides exact `mend mcp add` command and config object. |
| Session start can report current locks. | Supported by mflow/MCP | MendCode must call MCP/CLI status at session start. |
| Pre-edit enforcement queues or denies writes when locks cannot be acquired. | Scaffolded, unverified | `.mendcode/plugins/mflow-lock.js` uses queued locks before edits but needs active-build verification. |
| Queue priority is supported. | Implemented in mflow | Adapter passes `--priority ${MFLOW_LOCK_PRIORITY:-0}` equivalent. |
| Secrets are never printed. | Implemented in scaffold | No generated file includes a room secret; docs warn not to print secrets. |
| Deactivation stops mflow use without silently deleting config. | Pending in MendCode | Needs explicit MendCode control action. |
| README links this MendCode guide. | Implemented | README links this guide and the MendCode harness commands. |

## Handoff for the MendCode agent

Give the MendCode implementation agent this file:

```text
docs/harnesses/mendcode.md
```

What was completed on the mflow side:

- Published `mflow-cli@0.1.12` with MendCode scaffold support.
- Added `mflow install-hooks --harness mendcode`.
- Added `mflow hook-status --harness mendcode`.
- Added generated scaffold files for MendCode projects:
  - `.mendcode/plugins/mflow-lock.js`
  - `.mendcode/mflow-control.md`
  - `.mendcode/mcp.mflow.example.json`
- Kept all MendCode setup command shapes pnpm-only.
- Documented that hook enforcement is experimental until verified against the active MendCode build.

The MendCode agent should implement the product/runtime side using the contracts below: UI toggle, MCP registration, status reporting, and real pre-edit interception verification.

## Remaining MendCode-side work

1. Add the actual MendCode control surface with disabled/enabled-stopped/running states.
2. Implement activate/deactivate/remove-local-config as distinct user actions.
3. Wire MCP registration through MendCode's native config API if available; otherwise use the documented pnpm `mend mcp add` command.
4. Load `.mendcode/plugins/mflow-lock.js` or equivalent internal adapter.
5. Verify `tool.execute.before` blocks real file writes when queued lock acquisition fails.
6. At session start, call mflow status/locks and show blocked or queued files.
