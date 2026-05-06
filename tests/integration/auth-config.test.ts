import { describe, expect, test } from "bun:test";
import {
  HOSTED_GITHUB_OAUTH_ENV,
  SELF_HOSTED_AUTH_ENV,
  loadFutureAuthConfig,
} from "@mflow/shared";

describe("Future auth config", () => {
  test("defaults keep current OSS release accountless", () => {
    const config = loadFutureAuthConfig({});

    expect(config.hosted).toBeNull();
    expect(config.selfHosted.provider).toBe("none");
    expect(config.selfHosted.allowPasswordSignup).toBe(false);
  });

  test("hosted auth is GitHub-only when configured", () => {
    const config = loadFutureAuthConfig({
      [HOSTED_GITHUB_OAUTH_ENV.appId]: "123456",
      [HOSTED_GITHUB_OAUTH_ENV.clientId]: "Ov23liExample",
      [HOSTED_GITHUB_OAUTH_ENV.callbackUrl]: "https://hosted.example.com/auth/github/callback",
      [HOSTED_GITHUB_OAUTH_ENV.deviceFlowEnabled]: "true",
      [HOSTED_GITHUB_OAUTH_ENV.privateKeyPath]: "/secure/mflow-auth.pem",
    });

    expect(config.hosted).toEqual({
      provider: "github",
      appId: "123456",
      clientId: "Ov23liExample",
      callbackUrl: "https://hosted.example.com/auth/github/callback",
      deviceFlowEnabled: true,
      privateKeyPath: "/secure/mflow-auth.pem",
    });
  });

  test("self-hosted local email/password must be explicit and signup is closed by default", () => {
    const config = loadFutureAuthConfig({
      [SELF_HOSTED_AUTH_ENV.provider]: "local-email-password",
    });

    expect(config.selfHosted.provider).toBe("local-email-password");
    expect(config.selfHosted.allowPasswordSignup).toBe(false);
  });
});
