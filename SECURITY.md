# Security Policy

## Supported versions

Security fixes are handled for the current `main` branch and the latest tagged release once public releases begin.

## Reporting a vulnerability

Do not open a public GitHub issue with exploit details, secrets, private relay URLs, or reproduction data that could compromise another user.

Report privately by emailing the maintainer or using GitHub private vulnerability reporting once it is enabled for the public repository. Include:

- Affected version, commit, or deployment URL.
- Impact and attacker prerequisites.
- Minimal reproduction steps.
- Whether the issue affects the daemon, CLI, MCP server, signaling relay, or docs.
- Any logs or packet captures with secrets redacted.

Expected handling:

1. Maintainer acknowledges the report.
2. Maintainer reproduces and scopes the issue.
3. Fix is prepared on a private security branch or advisory workflow.
4. Patch, advisory, and release notes are published together when appropriate.

## Security model summary

Mflow syncs file changes between peers through a local daemon and an optional WebSocket signaling relay. File payloads are intended to be encrypted end-to-end with a room secret; the hosted relay should not be treated as trusted storage or a production-grade unlimited service.

Important caveats:

- Treat room secrets like passwords. Anyone with the room and secret can join.
- Use high-entropy secrets for real projects; do not use examples like `my-secret` outside demos.
- The relay can still observe metadata such as connection timing, IP address, room identifier, and message sizes.
- Do not sync secrets, `.env` files, credentials, private keys, or local tool state.
- Pause mflow around rebases, force-push workflows, destructive git operations, or large generated-file rewrites.

## Public relay

The public hosted relay is a fair-use convenience for demos and onboarding, not a production SLA. Self-host the relay for private teams, higher limits, compliance requirements, or sensitive workflows.
