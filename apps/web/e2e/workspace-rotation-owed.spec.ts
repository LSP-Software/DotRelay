import { expect, type Page, test } from "@playwright/test";
import { trustWorkspaceServer } from "./trust-server";

// The boundary reports environment.rotationOwed after a Member is removed or
// a Device revoked, until a rotation commits. Owners and admins get a
// non-blocking banner with the rotate command; plain Members get nothing.

const FIXTURE_PROJECT_ID = "00000000-0000-4000-8000-000000000021";

const owedBoundary = async (page: Page, rotationOwed: unknown) => {
  await page.route("**/api/workspace/boundary*", async (route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as {
        environment: Record<string, unknown>;
      };
      await route.fulfill({
        response,
        json: {
          ...body,
          environment: {
            ...body.environment,
            projectId: FIXTURE_PROJECT_ID,
            rotationOwed,
          },
        },
      });
    } catch {
      // The page navigated or closed while the boundary was in flight.
      await route.abort("failed").catch(() => undefined);
    }
  });
};

const openProject = async (page: Page) => {
  await page
    .locator("main")
    .getByRole("button", { name: /DotRelay/ })
    .click();
  await expect(page.getByRole("tab", { name: "production" })).toBeVisible();
};

test("an owner is asked to rotate after a member was removed, without blocking the editor", async ({
  page,
}) => {
  await owedBoundary(page, {
    since: "2026-11-12T09:30:00.000Z",
    sinceEpoch: "3",
    membershipRemovals: 1,
    deviceRevocations: 0,
  });
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await openProject(page);

  const banner = page.getByTestId("rotation-owed");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("1 member removed since");
  await expect(banner).toContainText("change any secrets");
  await expect(banner.getByTestId("rotation-owed-command")).toContainText(
    "dotrelay project rotate",
  );
  await expect(
    banner.getByRole("button", { name: /copy/i }).first(),
  ).toBeVisible();
  // Advice only: the environment and its editor stay usable.
  await expect(page.getByTestId("editor-context-active")).toBeVisible();
});

test("removals and revocations are both named", async ({ page }) => {
  await owedBoundary(page, {
    since: "2026-11-12T09:30:00.000Z",
    sinceEpoch: "3",
    membershipRemovals: 2,
    deviceRevocations: 1,
  });
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await openProject(page);
  await expect(page.getByTestId("rotation-owed")).toContainText(
    "2 members removed and 1 device revoked since",
  );
});

test("a plain member sees no rotation call to action", async ({ page }) => {
  await owedBoundary(page, {
    since: "2026-11-12T09:30:00.000Z",
    sinceEpoch: "3",
    membershipRemovals: 1,
    deviceRevocations: 0,
  });
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await openProject(page);
  // The owed rotation is on the boundary: an owner sees it...
  await expect(page.getByTestId("rotation-owed")).toBeVisible();
  // ...and the same boundary shows a plain member nothing.
  await page.locator("aside").getByRole("button", { name: "Members" }).click();
  await page.getByLabel("Preview role").selectOption("MEMBER");
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();
  await expect(page.getByRole("tab", { name: "production" })).toBeVisible();
  await expect(page.getByTestId("editor-context-active")).toBeVisible();
  await expect(page.getByTestId("rotation-owed")).toHaveCount(0);
});

test("no banner without an owed rotation", async ({ page }) => {
  await owedBoundary(page, null);
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await openProject(page);
  await expect(page.getByTestId("editor-context-active")).toBeVisible();
  await expect(page.getByTestId("rotation-owed")).toHaveCount(0);
});
