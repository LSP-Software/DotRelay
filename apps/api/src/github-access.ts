import { decryptOAuthToken } from "better-auth/oauth2";
import type { DotRelayAuth } from "./auth";

// User-to-server App grants only. Better Auth owns refresh-token rotation,
// encrypted persistence and expiry handling; nothing is returned to clients.
export const delegatedGitHubAccessToken = async (
  auth: DotRelayAuth,
  userId: string,
): Promise<string | null> => {
  try {
    const context = await auth.$context;
    const accounts = await context.internalAdapter.findAccounts(userId);
    const account = accounts.find(
      (candidate) => candidate.providerId === "github",
    );
    if (!account?.accessToken) return null;
    const stored = await decryptOAuthToken(
      account.accessToken,
      context as never,
    );
    if (typeof stored !== "string" || !stored.startsWith("ghu_")) return null;
    if (account.id) {
      const tokens = await auth.api.getAccessToken({
        body: { accountId: account.id, userId },
      });
      if (
        typeof tokens.accessToken !== "string" ||
        !tokens.accessToken.startsWith("ghu_")
      )
        return null;
      if (
        tokens.accessTokenExpiresAt &&
        new Date(tokens.accessTokenExpiresAt).getTime() <= Date.now()
      )
        return null;
      return tokens.accessToken;
    }
    // Lightweight in-memory adapters may omit account IDs. Never use an
    // expired token through that path; persistent production accounts have IDs.
    if (
      account.accessTokenExpiresAt &&
      new Date(account.accessTokenExpiresAt).getTime() <= Date.now()
    )
      return null;
    return stored;
  } catch {
    return null;
  }
};
