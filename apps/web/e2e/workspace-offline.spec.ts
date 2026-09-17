import { expect, type Page, test } from "@playwright/test";
import { e2eWorkspaceBoundary } from "../lib/workspace-boundary";

for (const imageLoads of [true, false]) {
  test(`the profile avatar ${imageLoads ? "shows the GitHub photo" : "falls back when the photo fails"}`, async ({
    page,
  }) => {
    const image = "https://avatars.githubusercontent.com/u/123";
    await page.route(image, (route) =>
      imageLoads
        ? route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="blue"/></svg>',
          })
        : route.abort(),
    );
    await page.route("**/api/workspace/boundary**", (route) => {
      const boundary = e2eWorkspaceBoundary("hosted");
      return route.fulfill({
        json: { ...boundary, session: { ...boundary.session, image } },
      });
    });
    await page.goto("/workspace");
    const avatar = page.locator('[data-slot="avatar"]');
    if (imageLoads) {
      await expect(avatar.locator("img")).toBeVisible();
      await expect(avatar.locator("img")).toHaveAttribute("src", image);
      await expect(
        avatar.locator('[data-slot="avatar-fallback"]'),
      ).toBeHidden();
    } else {
      await expect(avatar.locator('[data-slot="avatar-fallback"]')).toHaveText(
        "AR",
      );
      await expect(
        avatar.locator('[data-slot="avatar-fallback"]'),
      ).toBeVisible();
    }
  });
}

test("the profile avatar keeps initials when no photo is available", async ({
  page,
}) => {
  await page.route("**/api/workspace/boundary**", (route) => {
    const boundary = e2eWorkspaceBoundary("hosted");
    return route.fulfill({
      json: { ...boundary, session: { ...boundary.session, image: null } },
    });
  });
  await page.goto("/workspace");
  const avatar = page.locator('[data-slot="avatar"]');
  await expect(avatar.locator('[data-slot="avatar-fallback"]')).toHaveText(
    "AR",
  );
  await expect(avatar.locator("img")).toHaveCount(0);
});

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
