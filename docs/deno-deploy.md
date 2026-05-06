# Deno Deploy Relay

`packages/signaling/deno-deploy.ts` is a self-contained relay file intended for Deno Deploy. It mirrors the Bun signaling behavior and includes inline limits, landing, dashboard, health, WebSocket handling, and room cleanup.

## Project config

`deno.jsonc` currently declares:

```json
{
  "deploy": {
    "org": "obed0101",
    "app": "mflow-signal"
  }
}
```

Adjust org/app for your own deployment.

## Deploy

From the repo root, use Deno Deploy tooling for your account/project and point it at:

```text
packages/signaling/deno-deploy.ts
```

## Environment variables

Deno Deploy can provide the same `MFLOW_*` limit variables documented in [Relay Limits](./limits.md). If an env var is missing or invalid, the relay uses the default.

Example:

```text
MFLOW_MAX_PEERS_PER_ROOM=8
MFLOW_MAX_ACTIVE_ROOMS=500
MFLOW_MESSAGES_PER_MINUTE=300
```

## CLI usage

```bash
mflow start \
  --room my-project/main \
  --secret "$MFLOW_SECRET" \
  --signaling wss://your-deno-deploy-host.example/ws
```

Use the actual WebSocket URL for your Deno Deploy app.

## Important boundary

Deno Deploy can run the relay. If `MFLOW_REQUIRE_DASHBOARD_AUTH=true` and `MFLOW_HOSTED_GITHUB_CLIENT_ID` are configured, `/dashboard` and `/api/rooms` require GitHub device sign-in before room status is shown. The WebSocket sync path remains room + secret.
