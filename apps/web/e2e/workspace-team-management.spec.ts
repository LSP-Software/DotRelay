import { expect, type Page, test } from "@playwright/test";

// The Team id of the first fixture team (LSP Software).
const TEAM_A = "00000000-0000-4000-8000-000000000011";
// The signed-in User of the fixture session: the owner row it owns must
// never offer the user controls over themselves.
const SESSION_USER = "00000000-0000-4000-8000-000000000061";

type MembershipRow = {
  membershipId: string;
  userId: string;
  name: string | null;
  image: null;
  githubSubject: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  lifecycle: "ACTIVE" | "PENDING_KEY_GRANT" | "REMOVED";
};

type RoleCall = { membershipId: string; role: string };

type TeamAdministration = {
  readonly roleCalls: RoleCall[];
  readonly removeCalls: string[];
};

const row = (
  membershipId: string,
  userId: string,
  name: string | null,
  githubSubject: string,
  role: MembershipRow["role"],
  lifecycle: MembershipRow["lifecycle"],
): MembershipRow => ({
  membershipId,
  userId,
  name,
  image: null,
  githubSubject,
  role,
  lifecycle,
});

// Fakes the Team's membership record and its two mutation endpoints. The
// record is mutable: a role change or removal the service "applies" is
// reflected by the next read, so the table the workspace shows after a
// mutation is the Team's updated record, not a component-local echo.
const installTeamAdministration = async (
  page: Page,
  memberships: MembershipRow[],
): Promise<TeamAdministration> => {
  const rows = new Map(
    memberships.map((entry) => [entry.membershipId, { ...entry }]),
  );
  const roleCalls: RoleCall[] = [];
  const removeCalls: string[] = [];
  await page.route("**/api/v1/teams/*/memberships", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      json: { memberships: [...rows.values()], invitations: [] },
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
  // Route-specific handlers are registered last, so Playwright checks them
  // before the plain membership read above.
  await page.route("**/api/v1/teams/*/memberships/*/role", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const membershipId =
      route
        .request()
        .url()
        .match(/memberships\/([^/]+)\/role/)?.[1] ?? "";
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      role?: unknown;
    };
    const entry = rows.get(membershipId);
    if (!entry || typeof body.role !== "string")
      return route.fulfill({
        status: 400,
        json: { code: "invalid_request", title: "Invalid request" },
      });
    entry.role = body.role as MembershipRow["role"];
    roleCalls.push({ membershipId, role: body.role });
    return route.fulfill({
      status: 201,
      json: {
        membershipId: entry.membershipId,
        teamId: TEAM_A,
        role: entry.role,
        lifecycle: entry.lifecycle,
      },
    });
  });
  await page.route("**/api/v1/teams/*/memberships/*/remove", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const membershipId =
      route
        .request()
        .url()
        .match(/memberships\/([^/]+)\/remove/)?.[1] ?? "";
    const entry = rows.get(membershipId);
    if (!entry)
      return route.fulfill({
        status: 404,
        json: { code: "resource_not_found", title: "Not found" },
      });
    entry.lifecycle = "REMOVED";
    removeCalls.push(membershipId);
    return route.fulfill({
      status: 201,
      json: {
        membershipId: entry.membershipId,
        teamId: TEAM_A,
        lifecycle: entry.lifecycle,
      },
    });
  });
  return { roleCalls, removeCalls };
};

const openTeamView = async (page: Page) => {
  await page.goto("/workspace");
  await page.locator("aside").getByRole("button", { name: "Members" }).click();
};

test("a failed Team member load can be retried from the error itself", async ({
  page,
}) => {
  let up = false;
  await page.route("**/api/v1/teams/*/memberships", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (!up)
      return route.fulfill({
        status: 503,
        json: { code: "service_unavailable", title: "Service unavailable" },
      });
    return route.fulfill({
      json: {
        memberships: [
          {
            membershipId: "mem-owner",
            userId: SESSION_USER,
            name: "Ari Stone",
            image: null,
            githubSubject: "ari-stone",
            role: "OWNER",
            lifecycle: "ACTIVE",
          },
        ],
        invitations: [],
      },
    });
  });
  await openTeamView(page);
  const membersCard = page.getByTestId("members-card");
  // The failed load names the problem...
  await expect(membersCard.getByText("Couldn't load team members")).toBeVisible(
    { timeout: 15_000 },
  );
  // ...and its "Try again" is real: the service recovers, one click
  // re-loads the record...
  up = true;
  await membersCard.getByRole("button", { name: "Try again" }).click();
  await expect(membersCard.getByText("Ari Stone")).toBeVisible({
    timeout: 15_000,
  });
  // ...so the error goes away with it.
  await expect(membersCard.getByText("Couldn't load team members")).toHaveCount(
    0,
  );
});

test("an owner changes roles and removes members, but never controls their own row", async ({
  page,
}) => {
  const state = await installTeamAdministration(page, [
    row(SESSION_USER, SESSION_USER, "Ari Stone", "18473192", "OWNER", "ACTIVE"),
    row(
      "mem-admin",
      "user-mem-admin",
      "Ada Admin",
      "200101",
      "ADMIN",
      "ACTIVE",
    ),
    row("mem-member", "user-mem-member", null, "200202", "MEMBER", "ACTIVE"),
    row(
      "mem-gone",
      "user-mem-gone",
      "Rita Removed",
      "200303",
      "MEMBER",
      "REMOVED",
    ),
  ]);

  await openTeamView(page);
  const membersCard = page.getByTestId("members-card");
  await expect(membersCard.getByText("Ari Stone")).toBeVisible();

  // The signed-in User's own row offers no controls, whatever the row's role.
  const ownRow = membersCard.getByTestId(`member-row-${SESSION_USER}`);
  await expect(
    ownRow.getByRole("button", { name: "Remove member" }),
  ).toHaveCount(0);
  await expect(ownRow.getByRole("combobox")).toHaveCount(0);

  // A removed row keeps no controls either.
  await expect(
    membersCard.getByTestId("member-row-mem-gone").getByRole("button", {
      name: "Remove member",
    }),
  ).toHaveCount(0);

  // An owner may change any active Member's role: the control posts to the
  // service and the table then shows the Team's updated record.
  const memberRow = membersCard.getByTestId("member-row-mem-member");
  const roleSelect = memberRow.getByRole("combobox", {
    name: "Role for GitHub 200202",
  });
  await expect(roleSelect).toBeVisible();
  await expect(
    memberRow.getByRole("button", { name: "Remove member" }),
  ).toBeVisible();

  // A role change asks first. Cancelling leaves the role and the record
  // untouched.
  await roleSelect.selectOption("ADMIN");
  const roleDialog = page.getByTestId("role-change-dialog");
  await expect(roleDialog).toBeVisible();
  await expect(roleDialog).toContainText("Make GitHub 200202 an Admin?");
  await expect(roleDialog).toContainText("from Member to Admin");
  await roleDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(roleDialog).toBeHidden();
  await expect(roleSelect).toHaveValue("MEMBER");
  expect(state.roleCalls).toEqual([]);

  // Confirming posts the change; the refreshed record reports the
  // Membership's new role and the row's control now carries it.
  await roleSelect.selectOption("ADMIN");
  await roleDialog.getByRole("button", { name: "Change role" }).click();
  await expect(
    membersCard
      .getByTestId("member-row-mem-member")
      .getByRole("combobox", { name: "Role for GitHub 200202" }),
  ).toHaveValue("ADMIN");
  expect(state.roleCalls).toEqual([
    { membershipId: "mem-member", role: "ADMIN" },
  ]);

  // Every row's controls are named after its member, so a screen reader
  // never hears a list of identical "Remove member" buttons.
  await expect(
    membersCard.getByRole("button", {
      name: "Remove member Ada Admin",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    membersCard.getByRole("button", {
      name: "Share project keys with GitHub 200202",
      exact: true,
    }),
  ).toHaveCount(1);

  // Removing a member asks first, names them, and warns that removal does
  // not take back what they already downloaded. Cancel changes nothing.
  await membersCard
    .getByTestId("member-row-mem-admin")
    .getByRole("button", { name: "Remove member" })
    .click();
  const removeDialog = page.getByTestId("remove-member-dialog");
  await expect(removeDialog).toBeVisible();
  await expect(removeDialog).toContainText("Remove Ada Admin from");
  await expect(removeDialog).toContainText("Removal is permanent");
  await expect(removeDialog).toContainText("new invitation");
  await expect(removeDialog).toContainText("dotrelay project rotate");
  await removeDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(removeDialog).toBeHidden();
  expect(state.removeCalls).toEqual([]);

  // Confirming posts the removal; the refreshed record marks the membership
  // Removed, and the follow-up says to rotate with a copyable command.
  await membersCard
    .getByTestId("member-row-mem-admin")
    .getByRole("button", { name: "Remove member" })
    .click();
  await removeDialog.getByRole("button", { name: "Remove member" }).click();
  await expect(
    membersCard.getByTestId("member-row-mem-admin").getByText("Removed"),
  ).toBeVisible();
  expect(state.removeCalls).toEqual(["mem-admin"]);
  const notice = page.getByTestId("member-removed-notice");
  await expect(notice).toContainText("Ada Admin was removed");
  await expect(notice).toContainText("already downloaded");
  await expect(
    notice.getByRole("button", { name: "Copy command" }),
  ).toBeVisible();
  await expect(notice).toContainText("dotrelay project rotate");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toBeHidden();
});

test("a pending member reads as an action for admins and a wait for members", async ({
  page,
}) => {
  await installTeamAdministration(page, [
    row(SESSION_USER, SESSION_USER, "Ari Stone", "18473192", "OWNER", "ACTIVE"),
    row(
      "mem-pending",
      "user-mem-pending",
      "Pat Pending",
      "200505",
      "MEMBER",
      "PENDING_KEY_GRANT",
    ),
  ]);
  await openTeamView(page);
  const membersCard = page.getByTestId("members-card");
  const pendingRow = membersCard.getByTestId("member-row-mem-pending");
  await expect(pendingRow).toContainText("Action needed: share project keys");
  await expect(pendingRow).toContainText("unlocked");
  await expect(
    pendingRow.getByRole("button", {
      name: "Share project keys with Pat Pending",
    }),
  ).toBeVisible();

  await page.getByLabel("Preview role").selectOption("MEMBER");
  await expect(pendingRow).toContainText("Waiting for encryption keys");
  await expect(pendingRow).not.toContainText("Action needed");
});

test("invitation rows keep their badge in the Status column", async ({
  page,
}) => {
  await installTeamAdministration(page, [
    row(SESSION_USER, SESSION_USER, "Ari Stone", "18473192", "OWNER", "ACTIVE"),
  ]);
  await page.route("**/api/v1/teams/*/memberships", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      json: {
        memberships: [
          row(
            SESSION_USER,
            SESSION_USER,
            "Ari Stone",
            "18473192",
            "OWNER",
            "ACTIVE",
          ),
        ],
        invitations: [
          {
            invitationId: "inv-1",
            providerSubject: "583231",
            createdAt: "2026-01-03T00:00:00.000Z",
            expiresAt: "2026-01-10T00:00:00.000Z",
          },
        ],
      },
    });
  });
  await openTeamView(page);
  const membersCard = page.getByTestId("members-card");
  await expect(membersCard.getByTestId("invitation-row-inv-1")).toBeVisible();
  const headers = await membersCard.getByRole("columnheader").allTextContents();
  const statusIndex = headers.indexOf("Status");
  expect(headers).toEqual(["User", "Role", "Status", "Actions"]);
  const cells = membersCard
    .getByTestId("invitation-row-inv-1")
    .getByRole("cell");
  await expect(cells).toHaveCount(4);
  await expect(cells.nth(statusIndex)).toContainText("Invited, expires");
});

test("an admin removes members only and never touches owners, admins, or themselves", async ({
  page,
}) => {
  const state = await installTeamAdministration(page, [
    row(
      "mem-owner",
      "user-mem-owner",
      "Oscar Owner",
      "200404",
      "OWNER",
      "ACTIVE",
    ),
    row(SESSION_USER, SESSION_USER, "Ari Stone", "18473192", "OWNER", "ACTIVE"),
    row(
      "mem-admin",
      "user-mem-admin",
      "Ada Admin",
      "200101",
      "ADMIN",
      "ACTIVE",
    ),
    row("mem-member", "user-mem-member", null, "200202", "MEMBER", "ACTIVE"),
  ]);

  await openTeamView(page);
  const membersCard = page.getByTestId("members-card");
  await expect(membersCard.getByText("Ari Stone")).toBeVisible();

  // Preview the admin's view of the same record.
  await page.getByLabel("Preview role").selectOption("ADMIN");
  await expect(membersCard.getByText("Ari Stone")).toBeVisible();

  // No role controls at all: an admin cannot change any role.
  await expect(membersCard.getByRole("combobox")).toHaveCount(0);

  // Owners and other admins keep no controls; the admin's own row the same.
  await expect(
    membersCard
      .getByTestId("member-row-mem-owner")
      .getByRole("button", { name: "Remove member" }),
  ).toHaveCount(0);
  await expect(
    membersCard
      .getByTestId(`member-row-${SESSION_USER}`)
      .getByRole("button", { name: "Remove member" }),
  ).toHaveCount(0);
  await expect(
    membersCard
      .getByTestId("member-row-mem-admin")
      .getByRole("button", { name: "Remove member" }),
  ).toHaveCount(0);

  // A plain member is the only row an admin can act on.
  const memberRow = membersCard.getByTestId("member-row-mem-member");
  await expect(memberRow.getByRole("combobox")).toHaveCount(0);
  await memberRow.getByRole("button", { name: "Remove member" }).click();
  await page
    .getByTestId("remove-member-dialog")
    .getByRole("button", { name: "Remove member" })
    .click();
  await expect(
    membersCard.getByTestId("member-row-mem-member").getByText("Removed"),
  ).toBeVisible();
  expect(state.removeCalls).toEqual(["mem-member"]);
  expect(state.roleCalls).toEqual([]);
});

test("a plain member sees no role or removal controls", async ({ page }) => {
  await installTeamAdministration(page, [
    row(
      SESSION_USER,
      SESSION_USER,
      "Ari Stone",
      "18473192",
      "MEMBER",
      "ACTIVE",
    ),
    row(
      "mem-owner",
      "user-mem-owner",
      "Oscar Owner",
      "200404",
      "OWNER",
      "ACTIVE",
    ),
  ]);

  await openTeamView(page);
  const membersCard = page.getByTestId("members-card");
  await expect(membersCard.getByText("Ari Stone")).toBeVisible();

  await page.getByLabel("Preview role").selectOption("MEMBER");
  await expect(membersCard.getByText("Ari Stone")).toBeVisible();

  await expect(membersCard.getByRole("combobox")).toHaveCount(0);
  await expect(
    membersCard.getByRole("button", { name: "Remove member" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("invite-member")).toHaveCount(0);
});
