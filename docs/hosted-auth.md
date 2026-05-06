# Hosted auth roadmap

Hosted auth is not implemented in the current OSS release. The current release remains room + secret for both public relay usage and self-hosted relays.

This document records the intended direction so contributors do not add a weak password login by accident.

## Decision

| Deployment | Account creation |
|---|---|
| Public managed hosted service | GitHub OAuth only, with CLI device authorization |
| Self-hosted relay today | No accounts, room + secret |
| Future self-hosted admin mode | Optional local email/password, controlled by environment variables |

Do not add hosted email/password signup as the first managed auth path. GitHub OAuth is the safer first provider for the expected user base.

## Create the GitHub OAuth app

Use the GitHub OAuth app flow for the managed hosted service. GitHub's docs say OAuth apps can be created under a personal account or an organization, require a homepage URL and callback URL, and can enable Device Flow for CLI authorization.

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

9. Enable **Device Flow** for CLI login.
10. Register the app.
11. Copy the App ID, Client ID, and Client Secret into hosted runtime environment variables.
12. Download the generated private key, store it outside the repository, and point the hosted runtime to it with `MFLOW_HOSTED_GITHUB_PRIVATE_KEY_PATH`.

Use separate OAuth apps for development and production because GitHub OAuth apps have one callback URL.

## Hosted runtime environment

```bash
MFLOW_HOSTED_GITHUB_CLIENT_ID="..."
MFLOW_HOSTED_GITHUB_CLIENT_SECRET="..."
MFLOW_HOSTED_GITHUB_CALLBACK_URL="https://<your-hosted-domain>/auth/github/callback"
MFLOW_HOSTED_GITHUB_DEVICE_FLOW_ENABLED=true
MFLOW_HOSTED_GITHUB_APP_ID="..."
MFLOW_HOSTED_GITHUB_PRIVATE_KEY_PATH="/secure/path/to/mflow-auth.private-key.pem"
MFLOW_REQUIRE_DASHBOARD_AUTH=true
```

The Client Secret and private key must never ship in the CLI, frontend bundle, docs examples, npm package, or git history.

`MFLOW_REQUIRE_DASHBOARD_AUTH=true` gates `/dashboard` and `/api/rooms` behind GitHub sign-in. Keep it `false` for self-hosted accountless relays.

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
