# Security Model

mflow's current OSS security model is room + secret. There are no user accounts, OAuth, hosted teams, or device login in the current release.

## Trust boundaries

| Component | Trust assumption |
|---|---|
| Local CLI/daemon | Trusted by the user running it. It can read and write synced project files. |
| Room peers | Trusted if they know the room and secret. Any peer with both can join. |
| Signaling relay | Not trusted with plaintext file contents. It forwards encrypted payloads and room metadata. |
| Public relay | Shared fair-use infrastructure with no production SLA. |

## Secrets and keys

- The room secret is sensitive.
- The relay receives an auth hash derived from the secret for room admission checks.
- Payload encryption keys are derived locally.
- Do not use weak human secrets for real work.
- Share secrets out of band through a trusted channel.

Recommended secret generation:

```bash
openssl rand -hex 32
```

## What the relay can see

Depending on the protocol path and dashboard/status usage, the relay may observe operational metadata such as:

- client IP address
- room ID
- peer IDs and names
- join/leave timing
- message sizes and rates
- room activity event metadata exposed to dashboard/status views

Do not treat room names as secret.

## What the relay should not see

The relay should not need plaintext file contents for normal sync traffic. Encrypted payloads are forwarded as opaque data.

## Public relay limits

The public relay enforces caps to protect shared infrastructure. See [Relay Limits](./limits.md).

## File sync scope

mflow intentionally skips or ignores common unsafe/local paths such as:

- `.git/`
- `.mflow/`
- `.agents/`
- `.env*`
- build output directories
- binary files and oversized files

Review `.mflowignore` before syncing a sensitive project.

## Self-hosting security

When self-hosting:

- Use TLS outside trusted networks.
- Restrict ingress if the relay is internal.
- Tune rate limits.
- Monitor for repeated auth failures or rate-limit violations.
- Rotate room secrets when membership changes.

## Future hosted auth

A future hosted product may add GitHub OAuth with device-code login and account/team scoped tokens. That is not implemented today. It must not become required for self-hosted usage.

The future hosted flow requires at minimum:

- hosted auth API
- GitHub OAuth app with Device Flow enabled
- browser approval UI
- device code expiry and polling
- secure token storage
- logout/revocation
- hosted relay/account integration
- end-to-end tests

Future self-hosted admin auth may support local email/password through explicit environment configuration. It should remain off by default and separate from the public managed hosted auth path.

For the hosted public relay, `MFLOW_REQUIRE_DASHBOARD_AUTH=true` gates dashboard/API room status behind GitHub device sign-in. This does not replace room secrets for sync peers.
