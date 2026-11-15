import { expect, type Page, test } from "@playwright/test";

// Leaving or deleting a Team, and exporting or deleting the account
// (ADRs 0018, 0019). The service is faked per route; each spec checks what
// the browser sends and what it shows.

const TEAM_A = "00000000-0000-4000-8000-000000000011";
const SESSION_USER = "00000000-0000-4000-8000-000000000061";

const installMemberships = async (page: Page) => {
  await page.route("**/api/v1/teams/*/memberships", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      json: {
        memberships: [
          {
            membershipId: "mem-owner",
            userId: SESSION_USER,
            name: "Ari Stone",
            image: null,
            githubSubject: "18473192",
            role: "OWNER",
            lifecycle: "ACTIVE",
          },
          {
            membershipId: "mem-gone",
            userId: "user-gone",
            name: null,
            image: null,
            githubSubject: "deleted:user-gone",
            role: "MEMBER",
            lifecycle: "REMOVED",
            deleted: true,
          },
        ],
        invitations: [],
      },
    });
  });
  await page.route("**/api/v1/teams/*/invitations", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: { invitations: [] } });
  });
  await page.route("**/api/v1/invitations", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: { invitations: [], pendingMemberships: [] } });
  });
};

const openView = async (page: Page, name: "Team" | "Account") => {
  await page.goto("/workspace");
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });
  await page
    .locator("aside")
    .getByRole("button", { name, exact: true })
    .click();
};

test("the last owner is told to transfer ownership before leaving", async ({
  page,
}) => {
  await installMemberships(page);
  const leaveCalls: string[] = [];
  await page.route("**/api/v1/teams/*/leave", (route) => {
    leaveCalls.push(route.request().url());
    return route.fulfill({
      status: 409,
      json: {
        type: "https://dotrelay.dev/problems/v1",
        title: "Ownership transfer required",
        status: 409,
        code: "owner_transfer_required",
        detail: "Ownership transfer required",
      },
    });
  });
  await openView(page, "Team");
  // A deleted account stays in the Team's history under a neutral label.
  await expect(
    page.getByTestId("members-card").getByText("Deleted user"),
  ).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("leave-team").click();
  const dialog = page.getByTestId("leave-team-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-leave-team").click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Make another active member an owner",
  );
  expect(leaveCalls).toEqual([
    expect.stringContaining(`/api/v1/teams/${TEAM_A}/leave`),
  ]);
});

test("an owner deletes a Team only after typing its name", async ({ page }) => {
  await installMemberships(page);
  const bodies: unknown[] = [];
  await page.route("**/api/v1/teams/*/delete", (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? "null"));
    return route.fulfill({
      status: 201,
      json: {
        teamId: TEAM_A,
        status: "DELETED",
        deletedAt: new Date().toISOString(),
        purgeAfter: new Date().toISOString(),
      },
    });
  });
  await openView(page, "Team");
  const teamName = (
    await page.locator("#administration h1").first().textContent()
  )?.trim();
  expect(teamName).toBeTruthy();

  await page.getByTestId("delete-team").click();
  const dialog = page.getByTestId("delete-team-dialog");
  const confirm = dialog.getByTestId("confirm-delete-team");
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId("delete-team-confirmation").fill("not the name");
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId("delete-team-confirmation").fill(teamName ?? "");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toBeHidden();
  expect(bodies).toEqual([{ confirmName: teamName }]);
});

test("the account page exports data and deletes the account with a typed phrase", async ({
  page,
}) => {
  await page.route("**/api/v1/account/export", (route) =>
    route.fulfill({
      json: {
        format: "dotrelay-account-export-v1",
        user: { id: SESSION_USER },
      },
    }),
  );
  let blocking = true;
  await page.route("**/api/v1/account/deletion", (route) =>
    route.fulfill({
      json: {
        userId: SESSION_USER,
        blockingTeams: blocking
          ? [{ teamId: TEAM_A, name: "LSP Software" }]
          : [],
        teamsDeleted: [],
        teamsLeft: blocking ? [] : [{ teamId: TEAM_A, name: "LSP Software" }],
      },
    }),
  );
  const deleteBodies: unknown[] = [];
  await page.route("**/api/v1/account/delete", (route) => {
    deleteBodies.push(JSON.parse(route.request().postData() ?? "null"));
    return route.fulfill({
      status: 201,
      json: {
        userId: SESSION_USER,
        status: "DELETED",
        deletedAt: new Date().toISOString(),
        teamsDeleted: [],
        teamsLeft: [],
      },
    });
  });
  await openView(page, "Account");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByTestId("export-account").click();
  expect((await download).suggestedFilename()).toMatch(
    /^dotrelay-account-.*\.json$/,
  );

  // The sole owner of a Team with others cannot delete yet.
  await page.getByTestId("delete-account").click();
  const dialog = page.getByTestId("delete-account-dialog");
  await expect(dialog.getByText("Transfer ownership first")).toBeVisible();
  await expect(dialog.getByTestId("confirm-delete-account")).toBeDisabled();
  await expect(dialog.getByTestId("delete-account-confirmation")).toHaveCount(
    0,
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  blocking = false;
  await page.getByTestId("delete-account").click();
  await expect(dialog.getByText("LSP Software")).toBeVisible();
  const confirm = dialog.getByTestId("confirm-delete-account");
  await dialog.getByTestId("delete-account-confirmation").fill("delete");
  await expect(confirm).toBeDisabled();
  await dialog
    .getByTestId("delete-account-confirmation")
    .fill("delete my account");
  await confirm.click();
  await expect(page).toHaveURL(/\/sign-in/);
  expect(deleteBodies).toEqual([{ confirmUserId: SESSION_USER }]);
});
