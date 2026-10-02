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
  await expect(guide).toContainText(
    "Finish these steps to open your workspace",
  );
  await expect(
    guide.getByRole("heading", { name: "Set up this browser" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();
  await expect(guide).toContainText("recovery code");
  await expect(page.getByText("CLI on this machine")).toHaveCount(0);
});

test("the checklist cannot be dismissed before a recovery code exists", async ({
  page,
}) => {
  await page.goto("/workspace");
  await expect(page.getByTestId("getting-started")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("getting-started-continue")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });
  await expect(page.getByTestId("getting-started")).toBeVisible();
  await trustWorkspaceServer(page);
  await expect(page.getByTestId("getting-started-continue")).toHaveCount(0);
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

test("highlighting part of a command stays on that part", async ({ page }) => {
  await emptyAccount(page);
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  const command = page
    .getByTestId("getting-started")
    .getByTestId("getting-started-install-command");
  await expect(command).toContainText("npm install -g dotrelay@latest");
  await command.scrollIntoViewIfNeeded();

  // Setting a Range in script does not expand under user-select: all.
  // The drag is the gesture the browser rewrites into the whole command.
  const portion = "install";
  const box = await command.evaluate((el, needle) => {
    const textNode = el.firstChild;
    if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) {
      throw new Error("command text missing");
    }
    const full = textNode.textContent ?? "";
    const start = full.indexOf(needle);
    if (start < 0) throw new Error(`missing ${needle}`);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + needle.length);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, portion);

  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, y, { steps: 12 });
  await page.mouse.up();

  expect(
    await page.evaluate(() => window.getSelection()?.toString() ?? ""),
  ).toBe(portion);
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

test("returning to the tab advances each unfinished setup step", async ({
  page,
}) => {
  // Freeze timers so the ordinary poll cannot be what moves the checklist.
  // Coming back to the tab has to refresh on its own.
  await page.clock.install();
  let peerDevices: readonly Record<string, unknown>[] = [];
  let teams: readonly Record<string, unknown>[] = [];
  await page.route("**/api/v1/teams/*/memberships", (route) =>
    route.fulfill({ json: { memberships: [] } }),
  );
  await page.route("**/api/v1/invitations", (route) =>
    route.fulfill({ json: { invitations: [], pendingMemberships: [] } }),
  );
  await page.route("**/api/workspace/boundary*", async (route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        json: {
          ...body,
          catalog: { teams, projects: [] },
          peerDevices,
        },
      });
    } catch {
      await route.abort().catch(() => {});
    }
  });

  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  const guide = page.getByTestId("getting-started");
  await expect(
    guide.getByRole("heading", { name: "Set up the CLI" }),
  ).toBeVisible();

  const showAgain = () =>
    page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

  peerDevices = [
    {
      id: "00000000-0000-4000-8000-000000000041",
      encryptionPublicKey: "11".repeat(32),
      signingPublicKey: "22".repeat(32),
      hasEpochGrant: false,
      name: "dev",
      clientKind: "cli",
    },
  ];
  await showAgain();
  await expect(
    guide.getByRole("heading", { name: "Set up the CLI" }),
  ).toHaveCount(0);
  await expect(
    guide.getByRole("heading", { name: "Create your team" }),
  ).toBeVisible();

  teams = [
    {
      id: "00000000-0000-4000-8000-0000000000aa",
      name: "Relay",
      role: "OWNER",
    },
  ];
  await showAgain();
  await expect(
    guide.getByRole("heading", { name: "Set up this browser" }),
  ).toBeVisible();
  await expect(
    guide.getByRole("heading", { name: "Create your team" }),
  ).toHaveCount(0);
});
