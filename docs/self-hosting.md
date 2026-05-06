# Self-hosting

Self-hosting mflow means running your own signaling relay and pointing the CLI at it. The auth model remains room + secret. There is no account requirement.

## Modes

| Mode | Use when |
|---|---|
| Bun process | Local testing, private VM, internal server |
| Docker | Containerized deployment with Bun runtime |
| Deno Deploy | Lightweight edge-hosted relay |

## CLI configuration

```bash
mflow start \
  --room my-project/main \
  --secret "$MFLOW_SECRET" \
  --signaling ws://localhost:8787
```

For TLS-hosted relays, use `wss://`.

## Environment limits

See [Relay Limits](./limits.md) for all `MFLOW_*` variables.

Example:

```bash
MFLOW_MAX_PEERS_PER_ROOM=16 \
MFLOW_MAX_ACTIVE_ROOMS=500 \
MFLOW_IDLE_ROOM_TTL_MS=1800000 \
bun run packages/signaling/src/index.ts
```

## Future self-hosted auth

The current self-hosted relay does not need GitHub, email, or password login. If a future self-hosted admin/account mode is added, it should be opt-in through environment variables:

```bash
MFLOW_SELF_HOSTED_AUTH_PROVIDER=local-email-password
MFLOW_SELF_HOSTED_ALLOW_PASSWORD_SIGNUP=false
```

Hosted managed mflow should use GitHub OAuth/device authorization. Self-hosted deployments can stay accountless or choose local auth later.

## Dashboard/status

The relay exposes:

- `/health` for basic status.
- `/dashboard` for room-scoped monitoring.
- `/` landing/status page depending on the runtime file served.

A self-host relay should be treated as operational infrastructure, not as the future hosted account product.

## Security checklist

- Use TLS in untrusted networks.
- Use high-entropy room secrets.
- Do not log secrets.
- Limit ingress to trusted networks when possible.
- Set room/message limits appropriate to your capacity.
- Monitor rate-limit and room-full errors.
