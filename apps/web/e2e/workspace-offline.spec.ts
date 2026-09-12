import { expect, type Page, test } from "@playwright/test";

const expectOfflineState = async (page: Page) => {
  await expect(page.getByTestId("workspace-offline")).toBeVisible();
  await expect(page.getByTestId("workspace-retry")).toBeVisible();
  await expect(page.getByText("Signed out")).toBeVisible();
  await expect(page.getByText("Ari Stone")).toHaveCount(0);
  await expect(page.getByText("LSP Software")).toHaveCount(0);
  await expect(page.getByText("Acme Labs")).toHaveCount(0);
  await expect(page.getByText("LSP-Software / DotRelay")).toHaveCount(0);
};

test("a fresh visit shows a loading state before the offline state", async ({
  page,
}) => {
  await page.route("**/api/workspace/boundary**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.abort();
  });
  await page.goto("/workspace");
  await expect(page.getByTestId("workspace-loading")).toBeVisible();
  await expect(page.getByTestId("workspace-offline")).toBeVisible({
    timeout: 10_000,
  });
});

test("a fresh visit without a reachable boundary shows an offline state, not fixtures", async ({
  page,
}) => {
  await page.route("**/api/workspace/boundary**", (route) => route.abort());
  await page.goto("/workspace");
  await expectOfflineState(page);
});

test("a malformed boundary response shows the offline state, not fixtures", async ({
  page,
}) => {
  await page.route("**/api/workspace/boundary**", (route) =>
    route.fulfill({
      body: "not-json",
      contentType: "application/json",
      status: 200,
    }),
  );
  await page.goto("/workspace");
  await expectOfflineState(page);
});

test("a non-200 boundary response shows the offline state, not fixtures", async ({
  page,
}) => {
  await page.route("**/api/workspace/boundary**", (route) =>
    route.fulfill({
      body: JSON.stringify({ error: "unavailable" }),
      contentType: "application/json",
      status: 503,
    }),
  );
  await page.goto("/workspace");
  await expectOfflineState(page);
});

test("a failed refresh keeps the last verified workspace stale and reconnects", async ({
  page,
}) => {
  // Tolerate the default 30s refresh interval when a pre-existing dev server is
  // reused; a freshly started test server uses the short interval from the
  // Playwright config.
  test.setTimeout(180_000);
  const failing = { value: false };
  await page.route("**/api/workspace/boundary**", (route) =>
    failing.value ? route.abort() : route.continue(),
  );
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();

  failing.value = true;
  await expect(page.getByTestId("workspace-connection-error")).toBeVisible({
    timeout: 45_000,
  });
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();

  await page.getByTestId("workspace-retry").click();
  await expect(page.getByTestId("workspace-connection-error")).toBeVisible();

  failing.value = false;
  await expect(page.getByTestId("workspace-connection-error")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();
});
