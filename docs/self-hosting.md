# Local and self-hosted relays

Running your own mflow relay means pointing the CLI at a WebSocket relay you control. The auth model remains room + secret. There is no account requirement, no cloud account requirement, and no dependency on the public Deno relay.

## Recommended local-first flow

For the simplest free setup, run a relay locally or on any machine in the same WiFi/LAN, then point each worktree at that relay URL.

On the relay machine:

```bash
PORT=8787 bun run packages/signaling/src/index.ts
```

On the same machine:

```bash
mflow start --room my-project/main --secret "$MFLOW_SECRET" --signaling ws://localhost:8787
```

From another machine on the same WiFi/LAN, use the relay machine's LAN IP:

```bash
mflow start --room my-project/main --secret "$MFLOW_SECRET" --signaling ws://192.168.1.50:8787
```

If you need TLS or access from outside the LAN, put the relay behind a tunnel, reverse proxy, or hosting service and use `wss://`.

## Modes

| Mode | Use when |
|---|---|
| Bun process | Local testing, WiFi/LAN relay, private VM, internal server |
| Docker | Containerized deployment with Bun runtime |
| WebSocket hosting | Koyeb, Railway, Render, Fly.io, VPS, or any service that supports long-lived WebSockets |
| Cloudflare Tunnel | Quick public URL to a relay running on your machine |
| Deno Deploy | Legacy lightweight edge-hosted relay; useful for demos, but not the preferred default |

## CLI configuration

```bash
mflow start \
  --room my-project/main \
  --secret "$MFLOW_SECRET" \
  --signaling ws://localhost:8787
```

For TLS-hosted relays, use `wss://`.

## Docker quickstart

```bash
docker build -f packages/signaling/Dockerfile -t mflow-signaling .
docker run --rm -p 8787:8787 -e PORT=8787 mflow-signaling
```

Then point clients at `ws://localhost:8787` or `ws://<lan-ip>:8787`.

## Hosting service checklist

Use any host that supports:

- long-lived WebSocket connections
- a stable public URL or custom domain
- a configurable `PORT` environment variable
- no forced short request timeout for upgraded WebSocket connections

Good fits: VPS + Caddy/nginx, Koyeb, Railway, Render paid/always-on, Fly.io, or a Cloudflare Tunnel to a local process. Avoid serverless-only platforms that do not support durable WebSocket upgrades.

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
