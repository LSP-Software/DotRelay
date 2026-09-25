import { expect, type Page, test } from "@playwright/test";
import { trustWorkspaceServer } from "./trust-server";

// A signed-in user with zero Teams: the boundary reports an active session and
// an empty catalog. By DotRelay's model Teams are created by the CLI (`dotrelay
// init`), so the workspace must not show a dead empty "Choose a team" selector;
// it must point the user at the one real next action.

const zeroTeamsBoundary = async (page: Page) => {
  await page.route("**/api/workspace/boundary*", (route) => {
    return route
      .fetch()
      .then(async (response) => {
        const raw = await response.text();
        const body = JSON.parse(raw) as Record<string, unknown>;
        const mutated: Record<string, unknown> = {
          ...body,
          catalog: { teams: [], projects: [] },
        };
        return route.fulfill({
          body: JSON.stringify(mutated),
          headers: response.headers(),
          status: response.status(),
        });
      })
      .catch(() => {
        // If the fetch fails the client will show its offline state; let the
        // test fail on the offline assertion rather than swallow the error.
        return route.abort("failed");
      });
  });
};

test("a signed-in user with zero Teams is pointed at the CLI, not an empty selector", async ({
  page,
}) => {
  await page.route("**/api/v1/teams/*/memberships", (route) =>
    route.fulfill({ json: { memberships: [] } }),
  );
  await page.route("**/api/v1/invitations", (route) =>
    route.fulfill({ json: { invitations: [], pendingMemberships: [] } }),
  );
  await zeroTeamsBoundary(page);
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });

  // The dead "choose a team" affordances are gone: no Team switcher in the
  // sidebar or the header.
  await expect(page.getByRole("combobox", { name: "Team" })).toHaveCount(0);

  // Instead of a dead selector, the first-run checklist points at the CLI.
  const empty = page.getByTestId("no-teams-empty");
  await expect(empty).toBeVisible();
  await expect(
    empty.getByRole("heading", { name: "Get started" }),
  ).toBeVisible();
  await expect(
    empty.getByRole("heading", { name: "Create your team" }),
  ).toBeVisible();
  await expect(empty).toContainText("dotrelay init");

  // The Team nav is still reachable with an empty catalog. Memberships are
  // never requested without a Team, so this must not sit on "Loading members…".
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Team" })
    .click();
  await expect(page.getByText("Loading members…")).toHaveCount(0);
  await expect(page.getByTestId("members-card")).toHaveCount(0);
  await expect(page.getByTestId("no-teams-empty")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Get started" }),
  ).toBeVisible();

  const shot = await page.screenshot();
  console.log(`[verify] zero-teams shot=${shot}`);
});

test("a signed-in user with Teams keeps the team switcher", async ({
  page,
}) => {
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("combobox", { name: "Team" }).first(),
  ).toBeVisible();
});
