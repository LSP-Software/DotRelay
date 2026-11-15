import type { PrismaClient } from "./generated/prisma/client";
import { ensureServerProfile } from "./server-profile";

export type ResolveDotRelayUserInput = Readonly<{
  readonly serverProfileId: string;
  readonly authSubject: string;
  readonly serverProfileOrigin?: string;
  readonly allowRebind?: boolean;
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
  // The GitHub account that created the User is its identity: the recorded
  // subject never changes, and a sign-in whose GitHub account differs from
  // it (another account attached to the same login) is refused rather than
  // taking the User over.
  const persist = async () => {
    const user = await database.user.upsert({
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
      update: {},
      select: { id: true, githubSubject: true },
    });
    return user.githubSubject === account.accountId ? { id: user.id } : null;
  };
  try {
    return await persist();
  } catch (error) {
    // A development database can be reset while the API process stays up.
    // Its startup-created Server Profile row then disappears, so a valid
    // GitHub session cannot establish its DotRelay User until it is restored.
    if (
      !input.serverProfileOrigin ||
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "P2003"
    )
      throw error;
    await ensureServerProfile(database, {
      id: input.serverProfileId,
      origin: input.serverProfileOrigin,
      allowRebind: input.allowRebind === true,
    });
    return persist();
  }
};
