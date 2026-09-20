import { expect, type Page, test } from "@playwright/test";
import { trustWorkspaceServer } from "./trust-server";

// A signed-out state in a real deployment: the boundary relay keeps answering
// (connection stays online) but the session is expired, so the catalog is
// empty - the API's authentication_required shape. The workspace must then
// present the sign-in action instead of the signed-in empty states (which
// point at `dotrelay init`, an action a signed-out user cannot take) or
// contradictory "no longer available" alerts for the signed-in selection.

const signedOutBoundary = async (page: Page) => {
  await page.route("**/api/workspace/boundary*", (route) => {
    return route
      .fetch()
      .then(async (response) => {
        const raw = await response.text();
        const body = JSON.parse(raw) as Record<string, unknown>;
        const mutated: Record<string, unknown> = {
          ...body,
          connection: "online",
          catalog: { teams: [], projects: [] },
          session: { active: false },
          device: { active: false, label: "No active Device" },
          grantsReady: false,
          epochCurrent: false,
          rotationRequired: false,
          environment: { headRevision: "empty-environment" },
        };
        return route.fulfill({
          body: JSON.stringify(mutated),
          headers: response.headers(),
          status: response.status(),
        });
      })
      .catch(() => {
        return route.abort("failed");
      });
  });
};

const signInCard = (page: Page) => page.getByTestId("sign-in-required");

test("a signed-out visitor sees the sign-in action, not the CLI empty state", async ({
  page,
}) => {
  await signedOutBoundary(page);
  await page.goto("/workspace");
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });

  const card = signInCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(card.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/sign-in",
  );

  // The signed-in empty states and alerts must not mix in.
  await expect(page.getByTestId("no-teams-empty")).toHaveCount(0);
  await expect(page.getByTestId("workspace-missing-resource")).toHaveCount(0);
});

test("a signed-out deep link to a project resolves to sign-in, not a dead end", async ({
  page,
}) => {
  await signedOutBoundary(page);
  await page.goto(
    "/workspace?view=environment&project=00000000-0000-4000-8000-000000000021&environment=00000000-0000-4000-8000-000000000031",
  );
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });

  // The signed-in selection no longer exists for this user; naming it as
  // "no longer available" would contradict the real cause (signed out).
  await expect(page.getByTestId("sign-in-required")).toBeVisible();
  await expect(page.getByTestId("workspace-missing-resource")).toHaveCount(0);
});

test("a session that expires while the workspace is open resolves to sign-in", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/workspace?preview=protected");
  await trustWorkspaceServer(page);
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: /LSP-Software \/ DotRelay/ })
    .first()
    .click();
  await expect(page.getByRole("tab", { name: "production" })).toBeVisible();

  // The next boundary poll reports the expired session (the relay's
  // authentication_required shape); the 30s poll picks it up.
  await signedOutBoundary(page);
  await expect(page.getByTestId("sign-in-required")).toBeVisible();
  await expect(page.getByTestId("workspace-missing-resource")).toHaveCount(0);
  await expect(page.getByTestId("no-teams-empty")).toHaveCount(0);
});
