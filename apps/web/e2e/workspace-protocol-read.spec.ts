import { expect, type Page, test } from "@playwright/test";

const openFirstProject = async (page: Page) => {
  await page.getByRole("heading", { name: "LSP-Software / DotRelay" }).click();
};

const expectEmptyClaimAbsent = async (page: Page) => {
  await expect(
    page.getByText("Add a Variable to start this Manifest."),
  ).toHaveCount(0);
};

const expectMutationControlsBlocked = async (page: Page) => {
  await expect(
    page.getByRole("button", { name: "Add Variable" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
};

const expectFailedRead = async (page: Page) => {
  await expect(page.getByTestId("environment-read-failed")).toBeVisible();
  await expect(
    page.getByText("This Device could not read the current Environment."),
  ).toBeVisible();
  await expectEmptyClaimAbsent(page);
  await expectMutationControlsBlocked(page);
};

test("a slow or failed Environment read never presents an editable empty Manifest", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.route("**/api/v1/devices/bootstrap**", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.route(/\/api\/v1\/environments\/.*\/sync/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.abort();
  });
  await page.goto("/workspace");
  await openFirstProject(page);

  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
  await page.getByRole("button", { name: "Enroll browser" }).click();
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();

  await expect(page.getByRole("heading", { name: "Variables" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("environment-read-failed")).toBeVisible({
    timeout: 30_000,
  });
  await expectFailedRead(page);
  await expect(page.getByTestId("environment-retry-read")).toBeVisible();

  await page.getByTestId("environment-retry-read").click();
  await expect(
    page.getByText("Loading Environment…", { exact: true }),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expectEmptyClaimAbsent(page);
  await expectMutationControlsBlocked(page);

  await expect(page.getByTestId("environment-read-failed")).toBeVisible({
    timeout: 15_000,
  });
  await expectFailedRead(page);
});
