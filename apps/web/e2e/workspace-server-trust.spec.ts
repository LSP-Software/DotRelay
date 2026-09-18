import { expect, type Page, test } from "@playwright/test";
import { trustWorkspaceServer } from "./trust-server";

const openFirstProject = async (page: Page) => {
  await page.getByRole("heading", { name: "LSP-Software / DotRelay" }).click();
};

const trustGate = (page: Page) =>
  page.getByRole("heading", { name: "Trust this server" });

// The e2e deployment binds the workspace to the test origin and the fixture
// server's stable identity, so a correct confirmation must name exactly that
// pair before the user can decide.
const expectConfirmationNamesTheDestination = async (page: Page) => {
  const dialog = page.getByTestId("trust-server-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(new URL(page.url()).origin);
  await expect(dialog).toContainText("00000000-0000-4000-8000-000000000062");
};

test("the trust confirmation names the exact origin and server identity before deciding", async ({
  page,
}) => {
  await page.goto("/workspace");
  await expect(trustGate(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Trust this server" }).click();
  await expectConfirmationNamesTheDestination(page);
  await page.getByTestId("trust-server-confirm").click();
  await expect(trustGate(page)).toHaveCount(0);
});

test("declining the confirmation leaves the server untrusted and unpinned", async ({
  page,
}) => {
  await page.goto("/workspace");
  await expect(trustGate(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Trust this server" }).click();
  await expectConfirmationNamesTheDestination(page);
  await page
    .getByTestId("trust-server-dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(page.getByTestId("trust-server-dialog")).toBeHidden();
  await expect(trustGate(page)).toBeVisible();

  // No pin was recorded, so a fresh load asks again.
  await page.reload();
  await expect(trustGate(page)).toBeVisible({ timeout: 15_000 });
});

test("a recorded trust decision survives a reload", async ({ page }) => {
  await page.goto("/workspace");
  await trustWorkspaceServer(page);

  await page.reload();
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });
  await page.waitForTimeout(500);
  await expect(trustGate(page)).toHaveCount(0);

  // The workflow advances past the trust gate to the next one.
  await openFirstProject(page);
  await expect(
    page.getByRole("heading", { name: "Set up this browser" }),
  ).toBeVisible({ timeout: 15_000 });
});

test("a decision is scoped to the destination, not a preview label", async ({
  page,
}) => {
  await page.goto("/workspace");
  await trustWorkspaceServer(page);

  // The development fixture's previews share the deployment's origin and
  // server identity, so the recorded decision follows the destination.
  await page
    .getByRole("combobox", { name: "Server" })
    .selectOption("self-hosted");
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();
  await expect(trustGate(page)).toHaveCount(0);

  await page.getByRole("combobox", { name: "Server" }).selectOption("hosted");
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();
  await expect(trustGate(page)).toHaveCount(0);
});
