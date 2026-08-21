import type { PrismaClient } from "./generated/prisma/client";
import type { ServerProfileConfig } from "./profile";

export const resolveDotRelayUser = async (
  database: PrismaClient,
  profile: ServerProfileConfig,
  authSubject: string,
) => {
  const account = await database.authAccount.findFirst({
    where: { userId: authSubject, providerId: "github" },
    select: { accountId: true },
  });
  if (!account) return null;
  return database.user.upsert({
    where: {
      serverProfileId_authSubject: {
        serverProfileId: profile.id,
        authSubject,
      },
    },
    create: {
      serverProfileId: profile.id,
      authSubject,
      githubSubject: account.accountId,
    },
    update: { githubSubject: account.accountId },
    select: { id: true },
  });
};
