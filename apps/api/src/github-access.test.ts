import { expect, test } from "bun:test";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { createInMemoryAuth } from "./auth";
import { delegatedGitHubAccessToken } from "./github-access";
import { loadServerProfileConfig } from "./profile";

test("expired GitHub App grants refresh and persist encrypted tokens before use", async () => {
  const auth = createInMemoryAuth(
    loadServerProfileConfig({
      GITHUB_CLIENT_ID: "Iv1.test",
      GITHUB_CLIENT_SECRET: "test-secret",
    }),
  );
  const context = await auth.$context;
  context.options.account = {
    ...context.options.account,
    encryptOAuthTokens: true,
    modelName: "authAccount",
  };
  const user = await context.internalAdapter.createUser(
    {
      name: "Refresh test",
      email: "refresh@example.test",
      emailVerified: true,
    },
    { method: "oauth", oauth: { providerId: "github" } },
  );
  const account = await context.internalAdapter.createAccount({
    userId: user.id,
    providerId: "github",
    accountId: "1001",
    accessToken: await setTokenUtil("ghu_expired", context as never),
    refreshToken: await setTokenUtil("ghr_old", context as never),
    accessTokenExpiresAt: new Date(0),
    refreshTokenExpiresAt: new Date(Date.now() + 3600_000),
  });
  const provider = context.socialProviders.find(
    (provider) => provider.id === "github",
  );
  if (!provider) throw new Error("GitHub provider missing");
  let refreshes = 0;
  provider.refreshAccessToken = async (token) => {
    expect(token).toBe("ghr_old");
    refreshes++;
    return {
      accessToken: "ghu_fresh",
      refreshToken: "ghr_rotated",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 7200_000),
    };
  };
  expect(await delegatedGitHubAccessToken(auth, user.id)).toBe("ghu_fresh");
  const stored = (await context.internalAdapter.findAccounts(user.id)).find(
    (row) => row.id === account.id,
  );
  expect(stored?.accessToken).not.toBe("ghu_fresh");
  expect(
    await decryptOAuthToken(stored?.accessToken ?? "", context as never),
  ).toBe("ghu_fresh");
  expect(
    await decryptOAuthToken(stored?.refreshToken ?? "", context as never),
  ).toBe("ghr_rotated");
  expect(await delegatedGitHubAccessToken(auth, user.id)).toBe("ghu_fresh");
  expect(refreshes).toBe(1);
});
