import { expect, type Page, test } from "@playwright/test";
import { trustWorkspaceServer } from "./trust-server";

// A project that exists but has no Environments: the catalog can report it
// with an empty environments list (a Project is linked without an Environment
// yet). Opening it must not dead-end on an empty Environment page: the shell
// stays on the project's environment view and shows one next action
// (`dotrelay init`), matching the zero-teams and zero-projects states.

const FIXTURE_TEAM_ID = "00000000-0000-4000-8000-000000000011";

const noEnvironmentsBoundary = async (page: Page) => {
  await page.route("**/api/workspace/boundary*", (route) => {
    return route
      .fetch()
      .then(async (response) => {
        const raw = await response.text();
        const body = JSON.parse(raw) as Record<string, unknown>;
        const mutated: Record<string, unknown> = {
          ...body,
          catalog: {
            teams: [{ id: FIXTURE_TEAM_ID, name: "LSP Software" }],
            projects: [
              {
                id: "00000000-0000-4000-8000-000000000091",
                teamId: FIXTURE_TEAM_ID,
                githubRepositoryId: "123456789",
                lifecycle: "ACTIVE",
                repository: { owner: "LSP-Software", name: "AuditProbe" },
                environments: [],
              },
            ],
          },
        };
        return route.fulfill({
          body: JSON.stringify(mutated),
          headers: response.headers(),
          status: response.status(),
        });
      })
      .catch(() => {
        // If the fetch fails the client will show its offline state; let the
        // test fail on the state assertion rather than swallow the error.
        return route.abort("failed");
      });
  });
};

const openZeroEnvironmentsProject = async (page: Page) => {
  const card = page.locator("main").getByRole("button", { name: /AuditProbe/ });
  await card.click();
  await expect(
    page.getByRole("heading", { name: "LSP-Software / AuditProbe" }),
  ).toBeVisible();
};

test("opening a project with no environments shows its next action, not a dead end", async ({
  page,
}) => {
  await noEnvironmentsBoundary(page);
  await page.goto("/workspace");
  await trustWorkspaceServer(page);

  await openZeroEnvironmentsProject(page);

  const empty = page.getByTestId("no-environments-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("No environments yet");
  await expect(empty).toContainText("dotrelay init");

  // The navigation committed: the shell stays on the project's environment
  // view (the URL keeps project and view=environment) instead of silently
  // reverting to the projects list or blanking the page.
  expect(page.url()).toContain("view=environment");
  expect(page.url()).toContain("project=00000000-0000-4000-8000-000000000091");
});

test("a deep link to a project with no environments lands on its next action", async ({
  page,
}) => {
  await noEnvironmentsBoundary(page);
  await page.goto(
    `/workspace?profile=hosted&team=${FIXTURE_TEAM_ID}&project=00000000-0000-4000-8000-000000000091&view=environment`,
  );
  await trustWorkspaceServer(page);

  await expect(
    page.getByRole("heading", { name: "LSP-Software / AuditProbe" }),
  ).toBeVisible();
  const empty = page.getByTestId("no-environments-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("dotrelay init");
  expect(page.url()).toContain("view=environment");
});

test("a project with environments is unaffected", async ({ page }) => {
  await page.goto("/workspace");
  await trustWorkspaceServer(page);

  const dotRelay = page
    .locator("main")
    .getByRole("button", { name: /DotRelay/ });
  await dotRelay.click();

  await expect(page.getByRole("tab", { name: "production" })).toBeVisible();
  await expect(page.getByTestId("no-environments-empty")).toHaveCount(0);
});
