# MendCode Integration Request

Status: mflow-side support shipped in `mflow-cli@0.1.12` as a repo-local experimental MendCode scaffold. The local-first relay decision and generated MendCode control guide update are prepared for `mflow-cli@0.1.13`. MendCode should be local-first, not public-relay-first. The first-class MendCode UI/control still needs MendCode-side implementation.

This document is the implementation brief for a first-class MendCode integration. The current mflow baseline already provides CLI sync, MCP controls, queued locks, `claim`, `apply-patch`, and experimental harness adapters. MendCode should expose those capabilities as an explicit user-controlled feature instead of relying on manual setup.

## Implemented in this repo

mflow ships MendCode as a selectable harness scaffold in `mflow-cli@0.1.12` and newer. Use `mflow-cli@0.1.13` or newer for the local-first generated control guide:

```bash
pnpm dlx --package mflow-cli@0.1.13 mflow install-hooks --harness mendcode
pnpm dlx --package mflow-cli@0.1.13 mflow hook-status --harness mendcode
```

If your pnpm config uses `minimumReleaseAge`, a just-published version may be blocked briefly. Wait until the release age window passes or use the locally installed `mflow` binary after reviewing the package.

For an already installed global CLI:

```bash
mflow install-hooks --harness mendcode
mflow hook-status --harness mendcode
```

`install-hooks --harness mendcode` writes:

- `.mendcode/plugins/mflow-lock.js` — experimental `tool.execute.before` adapter that extracts edit/write/multiedit/apply-patch targets and runs queued locks before the write.
- `.mendcode/mflow-control.md` — the MendCode-side activation/control contract, local-first relay decision, pnpm MCP command shape, and manual lock/claim/apply-patch guidance.
- `.mendcode/mcp.mflow.example.json` — MendCode MCP config example using `pnpm dlx --package mflow-cli mflow-mcp --root /absolute/path/to/repo`.

`hook-status --harness mendcode` reports whether that scaffold is present and explicitly states that MendCode UI toggle and real hook verification remain MendCode-side work. It does not claim the MendCode-side hook is verified.

## Current mflow baseline

- CLI package: `mflow-cli`; installed binary: `mflow`.
- Local/self-hosted relays are the preferred path. Users should be able to run a relay on their machine or LAN without any cloud account.
- Hosted/public relay should no longer be the primary MendCode onboarding option because the existing Deno public URL has reliability/limit issues.
- Remote hosting is still supported through a custom signaling URL for teams that run their own relay on Docker, VPS, Koyeb, Railway, Render, Fly.io, Cloudflare Tunnel, or similar WebSocket-capable infrastructure.
- Locks support queueing with `--wait`, `--timeout`, and `--priority`.
- MCP server exposes status, peers, pause/resume, and locks.
- Harness docs already define a universal pre-edit contract in `docs/harnesses/hook-contract.md`.

## Desired MendCode UX

MendCode should let the user toggle mflow from inside MendCode:

1. User opens the mflow control.
2. MendCode shows whether mflow is disabled, enabled but stopped, or running.
3. If disabled, the user can activate it.
4. Activation asks which relay mode to use:
   - Local mflow relay (recommended): run or connect to an mflow relay on this computer or the local WiFi/LAN.
   - Remote relay URL: use a user-provided `ws://`, `wss://`, `http://`, or `https://` relay URL hosted by the user/team.
5. MendCode must not present the old public Deno relay as the default free option. If a legacy public URL is shown at all, label it as legacy/demo-only and unreliable.
6. If local mflow is selected, MendCode should open a modal that:
   - scans for existing mflow relays visible on the local network/WiFi, including relays running on another PC
   - shows detected relays with host, port, health/status, and room/peer count when available
   - lets the user choose an existing local relay or start one on this machine
   - lets the user copy the LAN URL for another machine
7. MendCode asks for or generates:
   - room name
   - room secret
   - whether to store the room secret locally
8. MendCode configures the local user/repo so future MendCode agents can use mflow.
9. User can deactivate mflow without deleting the room config.
10. User can remove local mflow config intentionally as a separate destructive action.

The mflow repo cannot implement this UI directly because MendCode's product/runtime code is outside this repository. The scaffold above provides the files, command shapes, and adapter contract for the MendCode implementation.

## Package manager requirement

MendCode setup must use pnpm, not npm.

Acceptable command shapes:

```bash
pnpm add -g mflow-cli
pnpm dlx --package mflow-cli mflow setup
pnpm dlx --package mflow-cli mflow-mcp --root /absolute/path/to/repo
```

Avoid documenting or running `npm install`, `npm i -g`, or npm-based MCP commands in the MendCode flow.

## MendCode configuration target

The integration should configure MCP for the active MendCode user/repo with the mflow MCP server. MendCode's current `mcp add` command is interactive, so product code should prefer the native config API or write the equivalent config shape directly:

```json
{
  "mcp": {
    "mflow": {
      "type": "local",
      "command": ["pnpm", "dlx", "--package", "mflow-cli", "mflow-mcp", "--root", "/absolute/path/to/repo"]
    }
  }
}
```

For a manual setup path, run `mend mcp add`, choose local, use `mflow` as the server name, and enter this command string:

```bash
pnpm dlx --package mflow-cli mflow-mcp --root /absolute/path/to/repo
```

The important contract is:

- command: `pnpm`
- args: `["dlx", "--package", "mflow-cli", "mflow-mcp", "--root", "<repo>"]`
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

## Local-first relay copy

Use copy like this when the local relay option is selected:

```text
Run mflow locally for free. Your room uses a relay on this computer or your local WiFi/LAN, so you do not need the public mflow relay or any cloud account. Other machines on the same network can join by using the detected LAN relay URL plus the same room name and room secret.
```

Use copy like this when the remote relay option is selected:

```text
Use a remote mflow relay URL when your agents are not on the same local network or when your team hosts a relay in Docker, a VPS, or a WebSocket-capable hosting service. Keep the room secret out of prompts, logs, commits, and screenshots.
```

## Acceptance criteria

- MendCode has an explicit mflow on/off control.
- Enabling mflow asks for local mflow relay vs remote relay URL.
- Local mflow selection can show detected relays on the local WiFi/LAN, including relays running on another PC.
- Public Deno relay is not shown as the default free path.
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
| Enabling mflow asks for local mflow relay vs remote relay URL. | Pending in MendCode | Local-first replaces the old public-relay-first decision. |
| Local mflow selection can show detected relays on the local WiFi/LAN. | Pending in MendCode | Discovery UX belongs in MendCode; mflow should expose/start local relays and health endpoints. |
| Public Deno relay is not shown as the default free path. | Ready for MendCode | The public relay should be treated as legacy/demo-only if shown at all. |
| Setup uses pnpm command shapes only. | Implemented for MendCode scaffold/docs | Generated MCP example uses `pnpm dlx --package mflow-cli`. |
| MCP is configured for the active MendCode repo/user. | Pending in MendCode | Scaffold provides MendCode's native local MCP config shape and the equivalent interactive `mend mcp add` inputs. |
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

Product decision after that release:

- MendCode should prefer local mflow relays over the old public Deno relay.
- The setup modal should offer **Local mflow relay** or **Remote relay URL**.
- The public Deno relay should not be presented as the default free choice because it has reliability/limit constraints.
- Local relay UX should detect mflow relays on the same WiFi/LAN, including relays running on another PC.

The MendCode agent should implement the product/runtime side using the contracts below: UI toggle, MCP registration, status reporting, and real pre-edit interception verification.

## Remaining MendCode-side work

1. Add the actual MendCode control surface with disabled/enabled-stopped/running states.
2. Implement activate/deactivate/remove-local-config as distinct user actions.
3. Replace the old public-relay choice with local mflow relay vs remote relay URL.
4. For local mflow, show detected LAN/WiFi mflow relays and offer to start one on this machine.
5. Wire MCP registration through MendCode's native config API if available; otherwise use the documented interactive `mend mcp add` inputs.
6. Load `.mendcode/plugins/mflow-lock.js` or equivalent internal adapter.
7. Verify `tool.execute.before` blocks real file writes when queued lock acquisition fails.
8. At session start, call mflow status/locks and show blocked or queued files.
