import type { BetterAuthDatabaseAdapter } from "@dotrelay/database";
import { betterAuth, type DBAdapterInstance } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { authRateLimitStorage } from "./auth-rate-limit";
import { type ServerProfileConfig, sharedCookieDomain } from "./profile";
import { configuredValkeyUrl } from "./protocol/rate-limit";

export const AUTH_CLIENT_ID = "dotrelay-cli";

export type AuthHooks = Readonly<{
  // Called with every verified GitHub profile at sign-in. A failure must
  // never block the sign-in, so it is caught here.
  readonly onGitHubProfile?: (
    profile: Readonly<{
      readonly githubSubject: string;
      readonly login: string;
    }>,
  ) => Promise<unknown>;
}>;

const createAuthWithAdapter = (
  database: DBAdapterInstance | undefined,
  profile: ServerProfileConfig,
  hooks: AuthHooks = {},
) => {
  const cookieDomain = sharedCookieDomain(profile);
  // Shared across API instances through Valkey; development and tests
  // without VALKEY_URL keep Better Auth's in-process memory store.
  const rateLimitStorage = authRateLimitStorage(configuredValkeyUrl());
  return betterAuth({
    appName: "DotRelay",
    baseURL: profile.origin,
    basePath: "/api/auth",
    secret: profile.authSecret,
    trustedOrigins: [profile.origin, profile.webOrigin],
    logger: { disabled: true },
    ...(database ? { database } : {}),
    ...(database
      ? {
          user: { modelName: "authUser" },
          verification: { modelName: "authVerification" },
        }
      : {}),
    account: {
      ...(database
        ? { modelName: "authAccount", encryptOAuthTokens: true }
        : {}),
      // A User has the one GitHub account that created them; a sign-in is
      // never linked to an existing User by email.
      accountLinking: { enabled: false },
    },
    // Sessions slide: each day of use extends them by 30 days. The absolute
    // limit (SESSION_MAX_AGE_MS in session.ts) ends any session 90 days
    // after creation, browser or CLI bearer alike.
    session: {
      modelName: "authSession",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      disableSessionRefresh: false,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: profile.isProduction,
      ...(profile.cookiePrefix ? { cookiePrefix: profile.cookiePrefix } : {}),
      ...(cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }
        : {}),
      ipAddress: profile.trustProxy
        ? {
            ipAddressHeaders: ["x-forwarded-for"],
            trustedProxies: [...profile.trustedProxies],
          }
        : {
            ipAddressHeaders: [],
          },
    },
    socialProviders:
      profile.githubClientId && profile.githubClientSecret
        ? {
            github: {
              clientId: profile.githubClientId,
              clientSecret: profile.githubClientSecret,
              // GitHub Apps use configured installation/user permissions, not
              // classic OAuth scopes. Never request broad OAuth repository access.
              disableDefaultScope: true,
              scope: [],
              // Runs on every GitHub sign-in with the profile GitHub returned
              // for this token. Only the login is kept (github_logins); the
              // user fields stay Better Auth's defaults.
              mapProfileToUser: async (github) => {
                await hooks
                  .onGitHubProfile?.({
                    githubSubject: String(github.id),
                    login: github.login,
                  })
                  .catch(() => undefined);
                return {};
              },
            },
          }
        : {},
    plugins: [
      // Only service-signed tokens (the form the session cookie and the
      // device token response carry) are bearer credentials.
      bearer({ requireSignature: true }),
      deviceAuthorization({
        verificationUri: `${profile.origin}/device`,
        // A device code is phishable: whoever approves it hands the
        // requesting CLI a full session. Ten minutes covers a real sign-in
        // and narrows the window for a code someone else sends.
        expiresIn: "10m",
        validateClient: (clientId) => clientId === AUTH_CLIENT_ID,
        ...(database
          ? { schema: { deviceCode: { modelName: "authDeviceCode" } } }
          : {}),
      }),
    ],
    // A failed GitHub return must land on the web app. The default sends the
    // browser to this API's `/`, which is a JSON 404, and Back walks straight
    // into GitHub again.
    onAPIError: {
      errorURL: `${profile.webOrigin}/sign-in`,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
      ...(rateLimitStorage ? { customStorage: rateLimitStorage } : {}),
      customRules: {
        // Device codes advertise a 5s poll. The per-code slow_down check is
        // what stops a client polling early; this bucket only has to fit one
        // CLI polling on that interval (plus a retry) without locking the
        // sign-in out for the rest of the minute.
        "/device/token": { window: 60, max: 120 },
        // The plugin caps verification checks at 5 per code lifetime. Each
        // GitHub round-trip reloads the approval page, so that cap turns a
        // retry into an outage for the rest of the code's lifetime.
        "/device": { window: 60, max: 60 },
        "/device/approve": { window: 60, max: 30 },
        "/device/deny": { window: 60, max: 30 },
        "/get-session": { window: 60, max: 120 },
        "/callback/*": { window: 60, max: 30 },
      },
    },
  });
};

export const createAuth = (
  database: BetterAuthDatabaseAdapter,
  profile: ServerProfileConfig,
  hooks: AuthHooks = {},
) => createAuthWithAdapter(database, profile, hooks);

export const createInMemoryAuth = (
  profile: ServerProfileConfig,
  hooks: AuthHooks = {},
) => createAuthWithAdapter(undefined, profile, hooks);

export type DotRelayAuth = ReturnType<typeof createAuth>;

/**
 * A bearer token in the form Better Auth's bearer plugin verifies: the
 * session token and its HMAC-SHA-256 under the auth secret, as the session
 * cookie carries it. Only these signed tokens are bearer credentials.
 */
export const signBearerToken = async (
  secret: string,
  token: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  );
  return `${token}.${Buffer.from(signature).toString("base64")}`;
};
