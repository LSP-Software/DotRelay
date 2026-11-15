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

// 1 to 39 letters, digits, or hyphens, not starting with a hyphen. Looser
// than GitHub's rule for new accounts, so older logins still fit.
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_SUBJECT = /^[1-9][0-9]{0,19}$/;

/**
 * Records the login of a verified GitHub profile for its user id. Called on
 * every GitHub sign-in so a rename is picked up. The login is display data:
 * it helps find a Member by login and never authorizes anything.
 */
export const recordGitHubLogin = async (
  database: Pick<PrismaClient, "gitHubLogin">,
  input: Readonly<{ readonly githubSubject: string; readonly login: string }>,
): Promise<boolean> => {
  if (
    !GITHUB_SUBJECT.test(input.githubSubject) ||
    !GITHUB_LOGIN.test(input.login)
  )
    return false;
  await database.gitHubLogin.upsert({
    where: { githubSubject: input.githubSubject },
    create: { githubSubject: input.githubSubject, login: input.login },
    update: { login: input.login },
  });
  return true;
};
