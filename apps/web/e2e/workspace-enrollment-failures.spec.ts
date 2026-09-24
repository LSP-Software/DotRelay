import { expect, test, type Page } from "@playwright/test";

// When the Server Profile rejects this browser's devices/bootstrap, the
// Devices view must name the situation a person can act on — and keep the
// retry action — instead of a single opaque rejection. The bootstrap route
// is intercepted here, so these tests pin the browser-side mapping of the
// service's stable problem codes to copy.

const openDevicesView = async (page: Page): Promise<void> => {
  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
};

const interceptBootstrapFailure = async (
  page: Page,
  status: number,
  code: string | null,
) => {
  await page.route("**/api/v1/devices/bootstrap**", (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(code === null ? {} : { code }),
    }),
  );
};

const startSetup = async (page: Page): Promise<void> => {
  await page.goto("/workspace");
  await openDevicesView(page);
  await page.getByRole("button", { name: "Set up browser" }).click();
};

const expectSetupBlocked = async (
  page: Page,
  message: string,
): Promise<void> => {
  await expect(page.getByText(message)).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator("#devices").getByText("Set up this browser", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("#devices").getByText("This browser is set up", {
      exact: true,
    }),
  ).toHaveCount(0);
};

test("an unreachable server during setup says so and keeps the retry action", async ({
  page,
}) => {
  await page.route("**/api/v1/devices/bootstrap**", (route) => route.abort());
  await startSetup(page);
  await expectSetupBlocked(
    page,
    "We couldn't reach the server. Check your connection and try again.",
  );
});

test("a service failure names the retry instead of a rejection", async ({
  page,
}) => {
  await interceptBootstrapFailure(page, 503, "service_unavailable");
  await startSetup(page);
  await expectSetupBlocked(
    page,
    "The server couldn't finish setting up this browser right now. Try again in a moment.",
  );
});

test("a rate-limited bootstrap tells the browser to wait", async ({ page }) => {
  await interceptBootstrapFailure(page, 429, "rate_limited");
  await startSetup(page);
  await expectSetupBlocked(
    page,
    "The server is limiting requests from this browser right now. Wait a moment, then try again.",
  );
});

test("a revoked device points at the Devices list", async ({ page }) => {
  await interceptBootstrapFailure(page, 409, "device_not_active");
  await startSetup(page);
  await expectSetupBlocked(
    page,
    "This browser's device is no longer active on the server. It may have been revoked; check the Devices list, then try again.",
  );
});

test("an incompatible server names the browser compatibility problem", async ({
  page,
}) => {
  await interceptBootstrapFailure(page, 400, "unsupported_crypto_runtime");
  await startSetup(page);
  await expectSetupBlocked(
    page,
    "This server uses an API or cryptography this browser can't use. Try a current version of your browser.",
  );
});

test("an unexpected problem code falls back to a neutral retry without dumping the code", async ({
  page,
}) => {
  await interceptBootstrapFailure(page, 400, "some_future_code");
  await startSetup(page);
  await expectSetupBlocked(
    page,
    "We couldn't set up this browser. Try again; if it keeps failing, the server or your connection may be the problem.",
  );
  await expect(page.getByText("some_future_code")).toHaveCount(0);
});

test("a conflicting bootstrap keeps the plain retry line", async ({ page }) => {
  await interceptBootstrapFailure(page, 409, "state_conflict");
  await startSetup(page);
  await expectSetupBlocked(page, "We couldn't set up this browser. Try again.");
});
