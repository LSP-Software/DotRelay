import type { BetterAuthDatabaseAdapter } from "@dotrelay/database";
import { betterAuth, type DBAdapterInstance } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { type ServerProfileConfig, sharedCookieDomain } from "./profile";

export const AUTH_CLIENT_ID = "dotrelay-cli";

const createAuthWithAdapter = (
  database: DBAdapterInstance | undefined,
  profile: ServerProfileConfig,
) => {
  const cookieDomain = sharedCookieDomain(profile);
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
          account: {
            modelName: "authAccount",
            encryptOAuthTokens: true,
          },
          verification: { modelName: "authVerification" },
        }
      : {}),
    session: {
      modelName: "authSession",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      disableSessionRefresh: false,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: profile.isProduction,
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
              // The provider already requests read:user and user:email; only
              // the repository intent is added here. The fine-grained GitHub
              // App's consent screen lets the User pick which repositories
              // the Server Profile may see; "repo" names that repository-
              // access intent on the grant.
              scope: ["repo"],
            },
          }
        : {},
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: `${profile.origin}/device`,
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
      customRules: {
        // Device codes advertise a 5s poll. The per-code slow_down check is
        // what stops a client polling early; this bucket only has to fit one
        // CLI polling on that interval (plus a retry) without locking the
        // sign-in out for the rest of the minute.
        "/device/token": { window: 60, max: 120 },
        // The plugin caps verification checks at 5 per code lifetime. Each
        // GitHub round-trip reloads the approval page, so that cap turns a
        // retry into a half-hour outage.
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
) => createAuthWithAdapter(database, profile);

export const createInMemoryAuth = (profile: ServerProfileConfig) =>
  createAuthWithAdapter(undefined, profile);

export type DotRelayAuth = ReturnType<typeof createAuth>;
