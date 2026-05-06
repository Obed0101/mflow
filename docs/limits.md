# Relay Limits

mflow ships conservative relay defaults for the shared public hosted relay. Self-hosted operators can override them with environment variables.

## Default limits

| Setting | Environment variable | Default |
|---|---|---:|
| Peers per room | `MFLOW_MAX_PEERS_PER_ROOM` | 4 |
| Max WebSocket message bytes | `MFLOW_MAX_WS_MESSAGE_BYTES` | 65,536 |
| Join attempts per minute per IP | `MFLOW_JOIN_ATTEMPTS_PER_MINUTE` | 10 |
| Messages per minute per IP | `MFLOW_MESSAGES_PER_MINUTE` | 120 |
| Violations before disconnect | `MFLOW_RATE_LIMIT_VIOLATIONS_BEFORE_DISCONNECT` | 3 |
| Unauthenticated timeout ms | `MFLOW_UNAUTHENTICATED_TIMEOUT_MS` | 10,000 |
| Unauthenticated sockets per IP | `MFLOW_MAX_UNAUTHENTICATED_SOCKETS_PER_IP` | 5 |
| Unauthenticated sockets globally | `MFLOW_MAX_UNAUTHENTICATED_SOCKETS_GLOBAL` | 500 |
| Active rooms | `MFLOW_MAX_ACTIVE_ROOMS` | 200 |
| Idle room TTL ms | `MFLOW_IDLE_ROOM_TTL_MS` | 900,000 |
| Activity entries per room | `MFLOW_MAX_ACTIVITY_ENTRIES_PER_ROOM` | 20 |

Malformed, empty, zero, negative, or non-integer values fall back to safe defaults.

## Example self-host limits

```bash
MFLOW_MAX_PEERS_PER_ROOM=12 \
MFLOW_MESSAGES_PER_MINUTE=600 \
MFLOW_MAX_ACTIVE_ROOMS=1000 \
bun run packages/signaling/src/index.ts
```

## Public relay stance

The public relay is fair-use and no-account. It is useful for demos and small teams, not for production reliability. Use self-hosting when you need:

- larger rooms
- private network placement
- higher message rates
- dedicated operational ownership
- custom retention/monitoring policy
