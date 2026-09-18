import { expect, type Page, test } from "@playwright/test";

// The account block in the sidebar is the only place a signed-in User can
// sign out. Signed-out visitors get a static block instead, so the sign-out
// control must exist only while a session is active.

const openAccountMenu = async (page: Page) => {
  await page
    .locator("aside")
    .getByRole("button", { name: /^Account menu: / })
    .click();
};

test("a signed-in account can sign out from the sidebar account menu", async ({
  page,
}) => {
  // The fixture's boundary reports an active session, but the sign-out call
  // targets the API origin; answer it directly so the spec never depends on
  // a real Better Auth session or GitHub credentials.
  await page.route("**/api/auth/sign-out", (route) =>
    route.fulfill({ json: {}, status: 200 }),
  );
  await page.goto("/workspace");
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });

  const account = page
    .locator("aside")
    .getByRole("button", { name: /^Account menu: / });
  await expect(account).toBeVisible();
  await expect(page.getByTestId("account-sign-out")).toHaveCount(0);

  await openAccountMenu(page);
  await expect(page.getByTestId("account-sign-out")).toBeVisible();
  await expect(page.getByTestId("account-sign-out")).toContainText("Sign out");

  await page.getByTestId("account-sign-out").click();
  await expect(page).toHaveURL(/\/sign-in/);
});

test("the mobile navigation offers sign out from the sheet", async ({
  page,
}) => {
  await page.route("**/api/auth/sign-out", (route) =>
    route.fulfill({ json: {}, status: 200 }),
  );
  await page.setViewportSize({ height: 800, width: 390 });
  await page.goto("/workspace");
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByTestId("mobile-sign-out")).toBeVisible();
  await page.getByTestId("mobile-sign-out").click();
  await expect(page).toHaveURL(/\/sign-in/);
});
