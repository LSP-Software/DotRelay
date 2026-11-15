import { expect, type Page, test } from "@playwright/test";

// A GitHub account outside the alpha list is signed in, but the API answers
// every request except sign-out with alpha_admission_required. The web must
// show the private alpha state with a way to ask for access and to sign out,
// never a generic error or a retry loop.

const alphaProblem = {
  body: JSON.stringify({
    type: "https://dotrelay.dev/problems/v1",
    title: "Alpha admission required",
    status: 403,
    code: "alpha_admission_required",
    detail: "Alpha admission required",
  }),
  contentType: "application/problem+json",
  status: 403,
};

const notAdmittedBoundary = async (page: Page) => {
  await page.route("**/api/workspace/boundary*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    return route.fulfill({
      json: {
        ...body,
        connection: "online",
        catalog: { teams: [], projects: [] },
        session: { active: false, alphaAdmissionRequired: true },
        device: { active: false, label: "No active Device" },
        grantsReady: false,
        epochCurrent: false,
        rotationRequired: false,
        environment: { headRevision: "empty-environment" },
      },
    });
  });
};

const expectNotice = async (page: Page) => {
  const notice = page.getByTestId("private-alpha-notice");
  await expect(notice).toContainText(
    "DotRelay is in private alpha — you're not on the list yet. Email support@dotrelay.dev to request access.",
  );
  const href = await notice
    .getByRole("link", { name: "support@dotrelay.dev" })
    .getAttribute("href");
  expect(href).toMatch(/^mailto:support@dotrelay\.dev\?/);
  expect(new URLSearchParams(href?.split("?")[1]).get("subject")).toBe(
    "DotRelay alpha access request",
  );
  await expect(page.getByTestId("private-alpha-request")).toHaveAttribute(
    "href",
    href ?? "",
  );
  return notice;
};

test("the workspace sends an account outside the alpha list to the private alpha page", async ({
  page,
}) => {
  await notAdmittedBoundary(page);
  let signOuts = 0;
  await page.route("**/api/auth/sign-out", (route) => {
    signOuts++;
    return route.fulfill({ json: { success: true }, status: 200 });
  });
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/private-alpha$/, { timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "Private alpha" }),
  ).toBeVisible();
  await expectNotice(page);
  await expect(page.getByTestId("workspace-connection-error")).toHaveCount(0);

  // A click before hydration does nothing, so retry until the sign-out
  // request goes out.
  await expect(async () => {
    if (signOuts === 0)
      await page
        .getByTestId("private-alpha-sign-out")
        .click({ timeout: 1_000 });
    expect(signOuts).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("the device page shows the private alpha state instead of a connection error", async ({
  page,
}) => {
  await page.route("**/api/auth/device**", (route) =>
    route.fulfill(alphaProblem),
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(alphaProblem),
  );
  await page.goto("/device?user_code=ABC12DEF");
  await expect(page.getByTestId("device-approval-alpha")).toBeVisible();
  await expectNotice(page);
  await expect(page.getByTestId("device-approval-connection")).toHaveCount(0);
  await expect(page.getByTestId("device-approval-retry")).toHaveCount(0);
});
