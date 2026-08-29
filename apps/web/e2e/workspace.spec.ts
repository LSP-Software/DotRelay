import { expect, test } from "@playwright/test";

test("landing page leads to GitHub sign-in without implying GitHub grants access", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "Configuration moves. Plaintext doesn't.",
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Enter workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to your Server Profile" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  await expect(
    page.getByText("GitHub identifies you; it does not grant DotRelay access."),
  ).toBeVisible();
});

test("role-aware administration and invitations expose pending key grants", async ({
  page,
}) => {
  await page.goto("/workspace");

  await page
    .getByRole("combobox", { name: "Preview Membership role" })
    .selectOption("OWNER");
  await page.getByRole("button", { name: "Invite member" }).click();
  await page.getByLabel("GitHub subject").fill("github:18473192");
  await page.getByRole("button", { name: "Create invitation" }).click();

  await expect(page.getByText("github:18473192")).toBeVisible();
  await expect(page.getByText("Pending key grant")).toBeVisible();

  await page
    .getByRole("combobox", { name: "Preview Membership role" })
    .selectOption("MEMBER");
  await expect(
    page.getByRole("button", { name: "Invite member" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Members can view active Team content only."),
  ).toBeVisible();
});

test("Environment archive and restore require explicit confirmation", async ({
  page,
}) => {
  await page.goto("/workspace");

  await page.getByRole("tab", { name: "Resources" }).click();
  await page.getByRole("button", { name: "Archive Environment" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Encrypted history is retained, but Manifest lanes will not be disclosed.",
  );
  await page.getByRole("button", { name: "Confirm archive" }).click();
  await expect(page.getByTestId("environment-lifecycle")).toHaveText(
    "Archived",
  );

  await page.getByRole("button", { name: "Restore Environment" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Restoring makes this Environment eligible for protected access again.",
  );
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(page.getByTestId("environment-lifecycle")).toHaveText("Active");
});

test("Server Profile switching separates profile trust, session, and Device state", async ({
  page,
}) => {
  await page.goto("/workspace");

  await page
    .getByRole("combobox", { name: "Server Profile" })
    .selectOption("self-hosted");
  await expect(page.getByText("Trust confirmation required")).toBeVisible();
  await expect(page.getByText("Session active")).toBeVisible();
  await expect(
    page.getByText("No active Device", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("combobox", { name: "Server Profile" })
    .selectOption("hosted");
  await expect(page.getByText("Profile pinned")).toBeVisible();
});

test("keyboard and responsive navigation keep critical routes reachable", async ({
  page,
}) => {
  await page.goto("/workspace");

  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to workspace" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "Administration" }),
  ).toBeVisible();
});

test("unsupported cryptography blocks protected content but leaves non-secret flows", async ({
  page,
}) => {
  await page.goto("/workspace");

  await expect(
    page.getByText("Protected content is unavailable"),
  ).toBeVisible();
  await expect(page.getByText("crypto_provider_unavailable")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Manage Devices" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open recovery" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Revision history" }),
  ).toBeVisible();
  await expect(page.getByText("DATABASE_URL=", { exact: false })).toHaveCount(
    0,
  );
});
