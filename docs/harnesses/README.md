# Harness Guides

mflow is runtime-agnostic. The stable baseline is always CLI + daemon + room secret. MCP adds agent controls on top.

- [Codex](./codex.md)
- [MendCode](./mendcode.md)
- [Claude Code](./claude-code.md)
- [Cursor](./cursor.md)
- [opencode](./opencode.md)
- [Custom CLI or agent harness](./custom-cli.md)
- [Universal Hook Contract](./hook-contract.md)

## Shared rule

Before git operations, pause mflow. If an agent forgets, mflow has an automatic `.git/index.lock` pause safety net, but that only starts when git creates the lock. Pause intentionally before staging and committing.

Before installing or modifying any repo-local harness hook, agents should run `mflow hook-status`, explain what is missing, and ask for human approval first.

MendCode support currently ships as a repo-local experimental scaffold (`mflow install-hooks --harness mendcode`) plus pnpm MCP guidance. The first-class activate/deactivate UI still needs MendCode-side implementation, and the scaffold should not be described as verified MendCode support.
