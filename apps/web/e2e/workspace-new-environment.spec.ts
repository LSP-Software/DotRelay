import { expect, type Page, test } from "@playwright/test";

const PROJECT_ID = "00000000-0000-4000-8000-000000000021";
const NEW_ENVIRONMENT_ID = "00000000-0000-4000-8000-0000000000e1";

// Fakes the create-environment route and a boundary that lists the new
// Environment once the service has created it.
const installEnvironmentCreation = async (page: Page) => {
  const created: string[] = [];
  await page.route("**/api/v1/projects/*/environments", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { label } = route.request().postDataJSON() as { label: string };
    created.push(label);
    return route.fulfill({
      status: 201,
      json: {
        id: NEW_ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        label,
        lifecycle: "active",
        currentHeadId: null,
        currentHeadHash: null,
      },
    });
  });
  await page.route("**/api/workspace/boundary**", async (route) => {
    try {
      const real = await route.fetch();
      const body = (await real.json()) as {
        catalog?: {
          projects?: {
            id: string;
            environments: Record<string, unknown>[];
          }[];
        };
      };
      const project = body.catalog?.projects?.find(
        (entry) => entry.id === PROJECT_ID,
      );
      const label = created.at(-1);
      if (project && label)
        project.environments.push({
          id: NEW_ENVIRONMENT_ID,
          label,
          lifecycle: "ACTIVE",
          currentHeadId: null,
        });
      await route.fulfill({ status: real.status(), json: body });
    } catch {
      await route.abort().catch(() => {});
    }
  });
  return created;
};

const openProject = async (page: Page) => {
  await page.goto("/workspace");
  await page.getByRole("heading", { name: "LSP-Software / DotRelay" }).click();
  await expect(
    page.getByRole("tablist", { name: "Environments" }),
  ).toBeVisible();
};

test("an owner creates a new environment and lands on it", async ({ page }) => {
  const created = await installEnvironmentCreation(page);
  await openProject(page);
  await page.getByRole("button", { name: "New environment" }).click();
  const dialog = page.getByTestId("new-environment-dialog");

  // Labels the server would refuse, or one the project already has, are
  // caught before anything is sent.
  await dialog.getByLabel("Name").fill("2nd env");
  await dialog.getByRole("button", { name: "Create environment" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Start with a letter");
  await dialog.getByLabel("Name").fill("staging");
  await dialog.getByRole("button", { name: "Create environment" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "already has an environment named staging",
  );
  expect(created).toEqual([]);

  await dialog.getByLabel("Name").fill("qa");
  await dialog.getByRole("button", { name: "Create environment" }).click();
  await expect(dialog).toBeHidden();
  expect(created).toEqual(["qa"]);
  // Once the refreshed workspace lists it, the new environment is selected.
  await expect(page.getByRole("tab", { name: "qa" })).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 15_000 },
  );
  await expect(page).toHaveURL(new RegExp(NEW_ENVIRONMENT_ID));
});

test("a plain member is not offered environment creation", async ({ page }) => {
  await page.goto("/workspace");
  await page.locator("aside").getByRole("button", { name: "Members" }).click();
  await page.getByLabel("Preview role").selectOption("MEMBER");
  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();
  await expect(
    page.getByRole("tablist", { name: "Environments" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New environment" }),
  ).toHaveCount(0);
});
