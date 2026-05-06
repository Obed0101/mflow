# Bun and Docker Relay

The Bun relay lives at `packages/signaling/src/index.ts`. A Dockerfile is provided at `packages/signaling/Dockerfile`.

## Run with Bun

```bash
bun install
PORT=8787 bun run packages/signaling/src/index.ts
```

Point the CLI at it:

```bash
mflow start --room my-room --secret "$MFLOW_SECRET" --signaling ws://localhost:8787
```

## Build Docker image

From the repo root:

```bash
docker build -f packages/signaling/Dockerfile -t mflow-signaling .
```

## Run Docker image

```bash
docker run --rm -p 8787:8787 \
  -e PORT=8787 \
  -e MFLOW_MAX_PEERS_PER_ROOM=8 \
  mflow-signaling
```

Then:

```bash
mflow start --room my-room --secret "$MFLOW_SECRET" --signaling ws://localhost:8787
```

## Production notes

- Put TLS in front of the relay for internet traffic.
- Keep `PORT` aligned with your platform.
- Set `MFLOW_*` limits for your expected load.
- Forward logs to your normal observability stack.
- Do not expose internal-only relays publicly unless intended.
