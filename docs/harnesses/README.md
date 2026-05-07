# Harness Guides

mflow is runtime-agnostic. The stable baseline is always CLI + daemon + room secret. MCP adds agent controls on top.

- [Codex](./codex.md)
- [Claude Code](./claude-code.md)
- [Cursor](./cursor.md)
- [opencode](./opencode.md)
- [Custom CLI or agent harness](./custom-cli.md)

## Shared rule

Before git operations, pause mflow. If an agent forgets, mflow has an automatic `.git/index.lock` pause safety net, but that only starts when git creates the lock. Pause intentionally before staging and committing.
