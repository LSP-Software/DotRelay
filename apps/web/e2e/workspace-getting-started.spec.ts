import { expect, type Page, test } from "@playwright/test";
import { trustWorkspaceServer } from "./trust-server";

const emptyAccount = async (page: Page) => {
  await page.route("**/api/v1/teams/*/memberships", (route) =>
    route.fulfill({ json: { memberships: [] } }),
  );
  await page.route("**/api/v1/invitations", (route) =>
    route.fulfill({ json: { invitations: [], pendingMemberships: [] } }),
  );
  await page.route("**/api/workspace/boundary*", async (route) => {
    // The workspace refreshes this boundary on a timer. Ending the test
    // disposes an in-flight fetch, and reading that body rejects. Left
    // uncaught, the rejection fails this test or the next one.
    try {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        json: {
          ...body,
          catalog: { teams: [], projects: [] },
          peerDevices: [],
        },
      });
    } catch {
      await route.abort().catch(() => {});
    }
  });
};

test("a signed-in browser that is not set up opens on the setup checklist", async ({
  page,
}) => {
  await page.goto("/workspace");
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });

  const guide = page.getByTestId("getting-started");
  await expect(
    guide.getByRole("heading", { name: "Get started" }),
  ).toBeVisible();
  await expect(guide).toContainText("GitHub sign-in only identifies you");
  await expect(
    guide.getByRole("heading", { name: "Trust this server" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Trust this server" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();
  await expect(guide).toContainText("recovery code");
  await expect(page.getByText("CLI on this machine")).toHaveCount(0);
});

test("continuing to projects keeps the trust gate and stays dismissed", async ({
  page,
}) => {
  await page.goto("/workspace");
  await expect(page.getByTestId("getting-started")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId("getting-started-continue").click();
  await expect(page.getByTestId("getting-started")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Trust this server" }),
  ).toBeVisible();
  await expect(page.getByTestId("getting-started-collapsed")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });
  await expect(page.getByTestId("getting-started")).toHaveCount(0);
  await expect(page.getByTestId("getting-started-collapsed")).toBeVisible();

  await page.getByRole("button", { name: "Show setup steps" }).click();
  await expect(page.getByTestId("getting-started")).toBeVisible();
  await trustWorkspaceServer(page);
  await expect(
    page.getByTestId("getting-started").getByRole("heading", {
      name: "Set up this browser",
    }),
  ).toBeVisible();
});

test("a new account is walked from the CLI install to the first team", async ({
  page,
}) => {
  await emptyAccount(page);
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  const guide = page.getByTestId("getting-started");
  await expect(
    guide.getByRole("heading", { name: "Set up the CLI" }),
  ).toBeVisible();
  await expect(guide).toContainText("npm install -g dotrelay@latest");
  await expect(
    guide.getByTestId("getting-started-setup-command"),
  ).toContainText("dotrelay setup");
  await expect(guide).toContainText("dotrelay init");
  await expect(page.getByRole("combobox", { name: "Team" })).toHaveCount(0);
  await expect(page.getByTestId("getting-started-continue")).toHaveCount(0);
});

test("the CLI install step offers package managers and keeps the choice", async ({
  page,
}) => {
  await emptyAccount(page);
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  const guide = page.getByTestId("getting-started");
  await expect(
    guide.getByRole("heading", { name: "Set up the CLI" }),
  ).toBeVisible();

  const install = guide.getByTestId("getting-started-install-command");
  await expect(install).toContainText("npm install -g dotrelay@latest");

  const bunChoice = guide.getByRole("button", { name: "bun" });
  await bunChoice.click();
  await expect(install).toContainText("bun add -g dotrelay");
  await expect(bunChoice).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });
  await expect(
    page.getByTestId("getting-started").getByRole("heading", {
      name: "Set up the CLI",
    }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("getting-started")
      .getByTestId("getting-started-install-command"),
  ).toContainText("bun add -g dotrelay");
});

test("a browser that is already trusted and enrolled skips the checklist", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });
  await expect(page.getByTestId("getting-started")).toHaveCount(0);
  await expect(page.getByTestId("getting-started-collapsed")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Variables" })).toBeVisible();
});
