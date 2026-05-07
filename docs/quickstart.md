# Quickstart

This guide starts two peers in the same mflow room.

## Requirements

- Bun for local development from source.
- npm for global package installation once published.
- Two worktrees, folders, machines, or terminals.
- A high-entropy room secret shared out of band.

## Install

Public package target:

```bash
npm i -g mflow-cli
```

From source:

```bash
git clone https://github.com/Obed0101/mflow.git
cd mflow
bun install
bun packages/cli/src/index.ts --help
```

## Start the first peer

```bash
export MFLOW_SECRET="$(openssl rand -hex 32)"
mflow start --room my-project/main --secret "$MFLOW_SECRET"
```

The hosted relay is used by default. Pass `--signaling` to use a self-hosted relay.

## Start the second peer

Run from another worktree or machine:

```bash
mflow start --room my-project/main --secret "$MFLOW_SECRET"
```

## Verify

```bash
mflow status
mflow status --watch
```

Create or edit a small text file in one peer. It should appear in the other peer after the daemon observes and propagates it.

## Pause and resume

Pause before a git operation or high-risk refactor:

```bash
mflow pause
# commit, rebase, or do a risky local operation
mflow resume
```

## Stop

```bash
mflow stop
```

## Self-hosted relay quickstart

If you run your own relay at `ws://localhost:8787`:

```bash
mflow start --room my-project/main --secret "$MFLOW_SECRET" --signaling ws://localhost:8787
```

Self-hosting does not require accounts or OAuth.
