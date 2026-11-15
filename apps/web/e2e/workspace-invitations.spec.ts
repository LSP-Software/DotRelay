import { expect, type Page, test } from "@playwright/test";
import { trustWorkspaceServer } from "./trust-server";

// The Team id of the first fixture team (LSP Software).
const TEAM_A = "00000000-0000-4000-8000-000000000011";
// The Team id of the second fixture team (Acme Labs).
const TEAM_B = "00000000-0000-4000-8000-000000000012";

type MembershipRow = {
  membershipId: string;
  userId: string;
  name: string | null;
  image: string | null;
  githubSubject: string;
  role?: "OWNER" | "ADMIN" | "MEMBER";
  lifecycle: "ACTIVE" | "PENDING_KEY_GRANT" | "REMOVED";
};

const member = (
  membershipId: string,
  name: string | null,
  githubSubject: string,
  role: "OWNER" | "ADMIN" | "MEMBER",
  lifecycle: MembershipRow["lifecycle"],
): MembershipRow => ({
  membershipId,
  userId: `user-${membershipId}`,
  name,
  image: null,
  githubSubject,
  role,
  lifecycle,
});

const invitation = (invitationId: string, providerSubject: string) => ({
  invitationId,
  providerSubject,
  createdAt: "2026-01-03T00:00:00.000Z",
  expiresAt: "2026-01-10T00:00:00.000Z",
});

// Serves a different membership record per Team so a switch (or reload) must
// re-read the service rather than reuse a component-local copy.
const installMembershipRoutes = async (
  page: Page,
  records: Record<
    string,
    { memberships: MembershipRow[]; invitations: unknown[] }
  >,
) => {
  await page.route("**/api/v1/teams/*/memberships", (route) => {
    const teamId = route
      .request()
      .url()
      .match(/\/teams\/([^/]+)\/memberships/)?.[1];
    const record = (teamId && records[teamId]) || {
      memberships: [],
      invitations: [],
    };
    return route.fulfill({ json: record });
  });
};

const installMyInvitationRoutes = async (
  page: Page,
  initial: {
    invitations: unknown[];
    pendingMemberships: unknown[];
  },
  afterAccept?: {
    invitations: unknown[];
    pendingMemberships: unknown[];
  },
) => {
  let accepted = false;
  await page.route("**/api/v1/invitations", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const current = accepted && afterAccept ? afterAccept : initial;
    return route.fulfill({ json: current });
  });
  await page.route("**/api/v1/invitations/*/accept", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    accepted = true;
    return route.fulfill({
      status: 201,
      json: {
        membershipId: "00000000-0000-4000-8000-000000000091",
        teamId: TEAM_B,
        lifecycle: "PENDING_KEY_GRANT",
      },
    });
  });
};

test("resolving an unknown GitHub login keeps the form and reports the problem", async ({
  page,
}) => {
  await installMembershipRoutes(page, {});
  await installMyInvitationRoutes(page, {
    invitations: [],
    pendingMemberships: [],
  });
  let resolveCalls = 0;
  let createCalls = 0;
  await page.route("**/api/v1/github-users/resolve", (route) => {
    resolveCalls += 1;
    return route.fulfill({
      status: 404,
      json: { code: "github_identity_not_found", title: "Not found" },
    });
  });
  await page.route("**/api/v1/teams/*/invitations", (route) => {
    if (route.request().method() === "POST") createCalls += 1;
    return route.fulfill({ status: 201, json: {} });
  });

  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await page.locator("aside").getByRole("button", { name: "Team" }).click();
  await page.getByRole("button", { name: "Invite member" }).click();

  await page.getByLabel("GitHub login").fill("nobody-here");
  await page.getByRole("button", { name: "Resolve" }).click();

  // The failed resolution stays on the form with an actionable explanation;
  // nothing is created.
  await expect(
    page.getByText(
      "We couldn't find that GitHub login. Check the spelling and try again.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("invitation-dialog")).toBeVisible();
  await expect(page.getByLabel("GitHub login")).toHaveValue("nobody-here");
  expect(resolveCalls).toBe(1);
  expect(createCalls).toBe(0);
});

test("a rejected invitation keeps the resolved identity and the error", async ({
  page,
}) => {
  await installMembershipRoutes(page, {});
  await installMyInvitationRoutes(page, {
    invitations: [],
    pendingMemberships: [],
  });
  await page.route("**/api/v1/github-users/resolve", (route) =>
    route.fulfill({ json: { login: "octocat", githubUserId: "583231" } }),
  );
  await page.route("**/api/v1/teams/*/invitations", (route) =>
    route.fulfill({
      status: 403,
      json: { code: "forbidden", title: "Forbidden" },
    }),
  );

  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await page.locator("aside").getByRole("button", { name: "Team" }).click();
  await page.getByRole("button", { name: "Invite member" }).click();

  await page.getByLabel("GitHub login").fill("octocat");
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText("GitHub ID 583231")).toBeVisible();

  await page.getByRole("button", { name: "Create invitation" }).click();

  // The create failed, so the dialog stays open on the confirmed identity
  // with the service's explanation, ready to retry.
  await expect(
    page.getByText("You don't have permission to do that on this team."),
  ).toBeVisible();
  await expect(page.getByTestId("invitation-dialog")).toBeVisible();
  await expect(page.getByText("GitHub ID 583231")).toBeVisible();
});

test("the Members table is the Team's record and survives reloads and switches", async ({
  page,
}) => {
  await installMembershipRoutes(page, {
    [TEAM_A]: {
      memberships: [
        member("a1", "Ari Stone", "18473192", "OWNER", "ACTIVE"),
        member("a2", null, "240949", "MEMBER", "PENDING_KEY_GRANT"),
      ],
      invitations: [invitation("i1", "583231")],
    },
    [TEAM_B]: {
      memberships: [member("b1", "Bea Acme", "300450", "OWNER", "ACTIVE")],
      invitations: [],
    },
  });
  await installMyInvitationRoutes(page, {
    invitations: [],
    pendingMemberships: [],
  });

  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await page.locator("aside").getByRole("button", { name: "Team" }).click();

  const membersCard = page.getByTestId("members-card");
  await expect(membersCard.getByText("Ari Stone")).toBeVisible();
  await expect(membersCard.getByText("Invitation pending")).toBeVisible();

  // Reloading re-reads the Team's record from the service, so the same
  // members are still there.
  await page.reload();
  await expect(membersCard.getByText("Ari Stone")).toBeVisible();
  await expect(membersCard.getByText("Invitation pending")).toBeVisible();

  // Switching Teams lands on that Team's Projects view and reads its own
  // record; re-open the Team view to see the members.
  await page.locator("aside").getByLabel("Team").selectOption(TEAM_B);
  await page.locator("aside").getByRole("button", { name: "Team" }).click();
  await expect(membersCard.getByText("Bea Acme")).toBeVisible();
  await expect(membersCard.getByText("Ari Stone")).toHaveCount(0);
  await expect(membersCard.getByText("Invitation pending")).toHaveCount(0);
});

test("an invitee accepts the invitation addressed to them and goes pending", async ({
  page,
}) => {
  await installMembershipRoutes(page, {});
  await installMyInvitationRoutes(
    page,
    {
      invitations: [
        {
          invitationId: "00000000-0000-4000-8000-000000000090",
          teamId: TEAM_B,
          teamName: "Acme Labs",
          providerSubject: "583231",
          createdAt: "2026-01-03T00:00:00.000Z",
          expiresAt: "2026-01-10T00:00:00.000Z",
        },
      ],
      pendingMemberships: [],
    },
    {
      invitations: [],
      pendingMemberships: [{ teamId: TEAM_B, teamName: "Acme Labs" }],
    },
  );

  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  // The invitation the User holds is surfaced even though the invitee has
  // not joined a Team yet.
  const card = page.getByTestId("my-invitations-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("Acme Labs", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Accept invitation" }).click();

  // After the service confirms acceptance, the record moves to the pending
  // key-grant state.
  await expect(card.getByText("Waiting for encryption keys")).toBeVisible();
  // The wait is not a dead end: it names who acts next and what to do once
  // they have.
  await expect(card).toContainText("Share project keys for you");
  await expect(card).toContainText("refresh this page");
  await expect(card).toContainText("dotrelay pull");
  await expect(
    card.getByRole("button", { name: "Accept invitation" }),
  ).toHaveCount(0);
});

test("an owner cancels a pending invitation after confirming", async ({
  page,
}) => {
  let invitations = [
    invitation("00000000-0000-4000-8000-0000000000a1", "583231"),
  ];
  await page.route("**/api/v1/teams/*/memberships", (route) =>
    route.fulfill({
      json: {
        memberships: [member("a1", "Ari Stone", "18473192", "OWNER", "ACTIVE")],
        invitations,
      },
    }),
  );
  await installMyInvitationRoutes(page, {
    invitations: [],
    pendingMemberships: [],
  });
  const revokeCalls: {
    url: string;
    key: string | null;
    body: string | null;
  }[] = [];
  await page.route("**/api/v1/teams/*/invitations/*/revoke", async (route) => {
    const request = route.request();
    revokeCalls.push({
      url: request.url(),
      key: await request.headerValue("Idempotency-Key"),
      body: request.postData(),
    });
    invitations = [];
    return route.fulfill({
      status: 201,
      json: {
        invitationId: "00000000-0000-4000-8000-0000000000a1",
        teamId: TEAM_A,
        status: "REVOKED",
      },
    });
  });

  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await page.locator("aside").getByRole("button", { name: "Team" }).click();
  const membersCard = page.getByTestId("members-card");
  const row = membersCard.getByTestId(
    "invitation-row-00000000-0000-4000-8000-0000000000a1",
  );
  await expect(row).toBeVisible();

  // Backing out of the confirmation changes nothing.
  await row.getByRole("button", { name: /Cancel invitation/ }).click();
  const dialog = page.getByTestId("cancel-invitation-dialog");
  await expect(dialog).toContainText("GitHub 583231");
  await dialog.getByRole("button", { name: "Keep invitation" }).click();
  await expect(dialog).toBeHidden();
  expect(revokeCalls).toHaveLength(0);

  await row.getByRole("button", { name: /Cancel invitation/ }).click();
  await dialog.getByRole("button", { name: "Cancel invitation" }).click();
  await expect(row).toHaveCount(0);
  expect(revokeCalls).toHaveLength(1);
  expect(revokeCalls[0]?.url).toContain(
    `/api/v1/teams/${TEAM_A}/invitations/00000000-0000-4000-8000-0000000000a1/revoke`,
  );
  expect(revokeCalls[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(revokeCalls[0]?.body).toBe("{}");
});

test("a refused cancellation stays on the invitation row", async ({ page }) => {
  await installMembershipRoutes(page, {
    [TEAM_A]: {
      memberships: [member("a1", "Ari Stone", "18473192", "OWNER", "ACTIVE")],
      invitations: [invitation("00000000-0000-4000-8000-0000000000a2", "77")],
    },
  });
  await installMyInvitationRoutes(page, {
    invitations: [],
    pendingMemberships: [],
  });
  await page.route("**/api/v1/teams/*/invitations/*/revoke", (route) =>
    route.fulfill({ status: 410, json: { code: "invitation_expired" } }),
  );
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await page.locator("aside").getByRole("button", { name: "Team" }).click();
  const row = page.getByTestId(
    "invitation-row-00000000-0000-4000-8000-0000000000a2",
  );
  await row.getByRole("button", { name: /Cancel invitation/ }).click();
  await page
    .getByTestId("cancel-invitation-dialog")
    .getByRole("button", { name: "Cancel invitation" })
    .click();
  await expect(row.getByRole("alert")).toContainText("no longer open");
});

test("an invitee declines an invitation addressed to them", async ({
  page,
}) => {
  await installMembershipRoutes(page, {});
  let open = true;
  await page.route("**/api/v1/invitations", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      json: {
        invitations: open
          ? [
              {
                invitationId: "00000000-0000-4000-8000-000000000090",
                teamId: TEAM_B,
                teamName: "Acme Labs",
                providerSubject: "583231",
                createdAt: "2026-01-03T00:00:00.000Z",
                expiresAt: "2026-01-10T00:00:00.000Z",
              },
            ]
          : [],
        pendingMemberships: [],
      },
    });
  });
  const declineCalls: { url: string; key: string | null }[] = [];
  await page.route("**/api/v1/invitations/*/decline", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    declineCalls.push({
      url: request.url(),
      key: await request.headerValue("Idempotency-Key"),
    });
    open = false;
    return route.fulfill({
      status: 201,
      json: {
        invitationId: "00000000-0000-4000-8000-000000000090",
        status: "DECLINED",
      },
    });
  });

  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  const card = page.getByTestId("my-invitations-card");
  await expect(card.getByText("Acme Labs", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Accept invitation" }),
  ).toBeVisible();

  await card
    .getByRole("button", { name: "Decline invitation to Acme Labs" })
    .click();
  const dialog = page.getByTestId("decline-invitation-dialog");
  await expect(dialog).toContainText("Acme Labs");
  await dialog.getByRole("button", { name: "Decline" }).click();

  // The service hides a declined invitation, so the card goes away.
  await expect(card).toHaveCount(0);
  expect(declineCalls).toHaveLength(1);
  expect(declineCalls[0]?.url).toContain(
    "/api/v1/invitations/00000000-0000-4000-8000-000000000090/decline",
  );
  expect(declineCalls[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
});

test("the pending invitation cap is explained when inviting", async ({
  page,
}) => {
  await installMembershipRoutes(page, {});
  await installMyInvitationRoutes(page, {
    invitations: [],
    pendingMemberships: [],
  });
  await page.route("**/api/v1/github-users/resolve", (route) =>
    route.fulfill({ json: { login: "octocat", githubUserId: "583231" } }),
  );
  await page.route("**/api/v1/teams/*/invitations", (route) =>
    route.fulfill({
      status: 409,
      json: { code: "pending_invitation_limit" },
    }),
  );
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await page.locator("aside").getByRole("button", { name: "Team" }).click();
  await page.getByRole("button", { name: "Invite member" }).click();
  await page.getByLabel("GitHub login").fill("octocat");
  await page.getByRole("button", { name: "Resolve" }).click();
  await page.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByTestId("invitation-dialog")).toContainText(
    "50 pending invitations",
  );
});
