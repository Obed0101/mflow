# Troubleshooting

## Daemon not running

```text
Daemon not running — start it with: mflow start
```

Run:

```bash
mflow start --room my-room --secret "$MFLOW_SECRET"
mflow status
```

If a stale socket or PID remains:

```bash
mflow stop
mflow start --room my-room --secret "$MFLOW_SECRET"
```

## Peers do not see each other

Check all peers use exactly the same:

- `--room`
- `--secret`
- `--signaling`
- transport mode

Then run:

```bash
mflow status
```

## Room auth fails

A room is keyed by the secret hash used when the room was created. If another peer joins with a different secret, the relay rejects it.

Fix: stop all peers for that room or choose a new room name and share one strong secret.

## Public relay says room is full

The public fair-use relay currently allows 4 peers per room. Use fewer peers, choose another room, or self-host.

## Rate limited

The public relay limits joins and messages per IP. Slow down reconnect loops and verify your client is not retrying with a wrong secret.

## Large files do not sync

The default max tracked file size is 1 MB. Binary files and known build artifacts are intentionally skipped.

Use `.mflowignore` for generated output:

```bash
mflow ignore "coverage/"
mflow ignore "dist/"
```

## ANSI colors in logs

Set:

```bash
NO_COLOR=1 mflow status
```

## Before opening an issue

Include:

- mflow version or git commit
- OS and shell
- command used
- whether the relay is public or self-hosted
- sanitized `mflow status` output
- logs without secrets
