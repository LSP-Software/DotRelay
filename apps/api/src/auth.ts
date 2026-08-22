import { prismaAdapter } from "@better-auth/prisma-adapter";
import type { PrismaClient } from "@dotrelay/database";
import { betterAuth, type DBAdapterInstance } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import type { ServerProfileConfig } from "./profile";

export const AUTH_CLIENT_ID = "dotrelay-cli";

const createAuthWithAdapter = (
  database: DBAdapterInstance | undefined,
  profile: ServerProfileConfig,
) =>
  betterAuth({
    appName: "DotRelay",
    baseURL: profile.origin,
    basePath: "/api/auth",
    secret: profile.authSecret,
    trustedOrigins: [profile.origin, profile.webOrigin],
    ...(database ? { database } : {}),
    user: { modelName: "authUser" },
    session: {
      modelName: "authSession",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      disableSessionRefresh: false,
      cookieCache: { enabled: false },
    },
    account: { modelName: "authAccount" },
    verification: { modelName: "authVerification" },
    socialProviders:
      profile.githubClientId && profile.githubClientSecret
        ? {
            github: {
              clientId: profile.githubClientId,
              clientSecret: profile.githubClientSecret,
              scope: ["user:email"],
            },
          }
        : {},
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: `${profile.origin}/device`,
        validateClient: (clientId) => clientId === AUTH_CLIENT_ID,
        schema: { deviceCode: { modelName: "authDeviceCode" } },
      }),
    ],
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
    },
  });

export const createAuth = (
  database: PrismaClient,
  profile: ServerProfileConfig,
) =>
  createAuthWithAdapter(
    prismaAdapter(database, {
      provider: "postgresql",
      transaction: true,
    }),
    profile,
  );

export const createInMemoryAuth = (profile: ServerProfileConfig) =>
  createAuthWithAdapter(undefined, profile);

export type DotRelayAuth = ReturnType<typeof createAuth>;
