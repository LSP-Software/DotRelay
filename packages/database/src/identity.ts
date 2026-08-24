import type { PrismaClient } from "./generated/prisma/client";

export type ResolveDotRelayUserInput = Readonly<{
  readonly serverProfileId: string;
  readonly authSubject: string;
}>;

export const resolveDotRelayUser = async (
  database: PrismaClient,
  input: ResolveDotRelayUserInput,
) => {
  const account = await database.authAccount.findFirst({
    where: { userId: input.authSubject, providerId: "github" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { accountId: true },
  });
  if (!account) return null;
  return database.user.upsert({
    where: {
      serverProfileId_authSubject: {
        serverProfileId: input.serverProfileId,
        authSubject: input.authSubject,
      },
    },
    create: {
      serverProfileId: input.serverProfileId,
      authSubject: input.authSubject,
      githubSubject: account.accountId,
    },
    update: { githubSubject: account.accountId },
    select: { id: true },
  });
};
