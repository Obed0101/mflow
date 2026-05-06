export type HostedAuthProvider = "github";
export type SelfHostedAuthProvider = "none" | "local-email-password";

export interface HostedAuthConfig {
  provider: HostedAuthProvider;
  appId: string | null;
  clientId: string;
  callbackUrl: string;
  deviceFlowEnabled: boolean;
  privateKeyPath: string | null;
}

export interface SelfHostedAuthConfig {
  provider: SelfHostedAuthProvider;
  allowPasswordSignup: boolean;
}

export interface FutureAuthConfig {
  hosted: HostedAuthConfig | null;
  selfHosted: SelfHostedAuthConfig;
}

export const HOSTED_GITHUB_OAUTH_ENV = {
  appId: "MFLOW_HOSTED_GITHUB_APP_ID",
  clientId: "MFLOW_HOSTED_GITHUB_CLIENT_ID",
  clientSecret: "MFLOW_HOSTED_GITHUB_CLIENT_SECRET",
  callbackUrl: "MFLOW_HOSTED_GITHUB_CALLBACK_URL",
  deviceFlowEnabled: "MFLOW_HOSTED_GITHUB_DEVICE_FLOW_ENABLED",
  privateKeyPath: "MFLOW_HOSTED_GITHUB_PRIVATE_KEY_PATH",
} as const;

export const SELF_HOSTED_AUTH_ENV = {
  provider: "MFLOW_SELF_HOSTED_AUTH_PROVIDER",
  allowPasswordSignup: "MFLOW_SELF_HOSTED_ALLOW_PASSWORD_SIGNUP",
} as const;

export function loadFutureAuthConfig(env: Record<string, string | undefined> = process.env): FutureAuthConfig {
  const clientId = env[HOSTED_GITHUB_OAUTH_ENV.clientId]?.trim();
  const callbackUrl = env[HOSTED_GITHUB_OAUTH_ENV.callbackUrl]?.trim();
  const selfHostedProvider = parseSelfHostedAuthProvider(env[SELF_HOSTED_AUTH_ENV.provider]);

  return {
    hosted: clientId && callbackUrl
      ? {
          provider: "github",
          appId: env[HOSTED_GITHUB_OAUTH_ENV.appId]?.trim() || null,
          clientId,
          callbackUrl,
          deviceFlowEnabled: parseBoolean(env[HOSTED_GITHUB_OAUTH_ENV.deviceFlowEnabled], true),
          privateKeyPath: env[HOSTED_GITHUB_OAUTH_ENV.privateKeyPath]?.trim() || null,
        }
      : null,
    selfHosted: {
      provider: selfHostedProvider,
      allowPasswordSignup: parseBoolean(env[SELF_HOSTED_AUTH_ENV.allowPasswordSignup], false),
    },
  };
}

function parseSelfHostedAuthProvider(value: string | undefined): SelfHostedAuthProvider {
  if (value === "local-email-password") return value;
  return "none";
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}
