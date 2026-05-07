# Hosted auth roadmap

Hosted account auth is not part of the OSS self-hosted path. The hosted dashboard can require GitHub OAuth before room status is shown, but sync access still uses room + secret.

This document records the intended direction so contributors do not add a weak password login by accident.

## Decision

| Deployment | Account creation |
|---|---|
| Public hosted dashboard | GitHub OAuth browser sign-in |
| Self-hosted relay today | No accounts, room + secret |
| Future CLI managed auth | GitHub Device Flow |

Do not add hosted email/password signup as the first managed auth path. GitHub OAuth is the safer first provider for the expected user base.

## Create the GitHub OAuth app

Use the GitHub OAuth app flow for the managed hosted service. GitHub's docs say OAuth apps can be created under a personal account or an organization, require a homepage URL and callback URL, and uses a callback URL for browser sign-in. Device Flow is only needed for a future CLI login.

Steps:

1. Open GitHub.
2. Go to **Settings**.
3. Go to **Developer settings**.
4. Open **OAuth Apps**.
5. Click **New OAuth App** or **Register a new application**.
6. Application name:

   ```text
   mflow
   ```

7. Homepage URL:

   ```text
   https://<your-hosted-domain>
   ```

8. Authorization callback URL:

   ```text
   https://<your-hosted-domain>/auth/github/callback
   ```

9. Device Flow is optional and only needed for future CLI login.
10. Register the app.
11. Copy the Client ID and Client Secret into hosted runtime environment variables.


Use separate OAuth apps for development and production because GitHub OAuth apps have one callback URL.

## Hosted runtime environment

```bash
MFLOW_HOSTED_GITHUB_CLIENT_ID="..."
MFLOW_HOSTED_GITHUB_CLIENT_SECRET="..."
MFLOW_HOSTED_GITHUB_CALLBACK_URL="https://<your-hosted-domain>/auth/github/callback"
MFLOW_REQUIRE_DASHBOARD_AUTH=true
MFLOW_API_KEY_PEPPER="<long-random-server-secret>"
MFLOW_SESSION_SECRET="<long-random-server-secret>"
```

The Client Secret and private key must never ship in the CLI, frontend bundle, docs examples, npm package, or git history.

`MFLOW_REQUIRE_DASHBOARD_AUTH=true` gates `/dashboard` and `/api/rooms` behind GitHub sign-in. Keep it `false` for self-hosted accountless relays.

`MFLOW_API_KEY_PEPPER` is required before `/settings` can create hosted API keys. The server stores only SHA-256 hashes derived from the plaintext key plus this pepper. Plaintext keys are returned once at creation time, then only the suffix, creation time, expiration, last-use time, and revocation state are shown.

Deno Deploy uses Deno KV for hosted dashboard sessions and API keys when KV is available. Local/self-hosted development may fall back to process memory; do not treat that fallback as production persistence.

Hosted browser sessions use a signed HttpOnly cookie with a 7-day expiration. `MFLOW_SESSION_SECRET` signs that cookie. If it is not set, the server falls back to `MFLOW_API_KEY_PEPPER` or the GitHub client secret.

## Future CLI flow

```text
mflow login
Open: https://github.com/login/device
Code: ABCD-EFGH
Waiting for approval...
```

The hosted auth API will request a GitHub device code, show the GitHub verification URL and user code to the CLI, poll at GitHub's returned interval, then issue a scoped mflow CLI token after approval.

The CLI token must be stored in OS keychain or an explicit secure token store. `mflow logout` must delete the local token and revoke it server-side when possible.

## Future self-hosted auth

Self-hosted users should not be forced to use GitHub. If a future self-hosted admin/account mode is added, it should be explicit:

```bash
MFLOW_SELF_HOSTED_AUTH_PROVIDER=local-email-password
MFLOW_SELF_HOSTED_ALLOW_PASSWORD_SIGNUP=false
```

Rules:

- Default remains no accounts, room + secret.
- Local email/password is self-host only.
- Password signup is closed by default.
- Passwords must be hashed with a modern password hashing scheme.
- No hosted managed service should use local email/password as the first auth path.

## References

- GitHub OAuth app creation: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app
- GitHub OAuth device flow: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
