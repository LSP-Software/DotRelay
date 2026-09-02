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

test("protected Environment editor keeps Values masked and previews a local draft", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");

  await expect(
    page.getByRole("heading", { name: "Environment editor" }),
  ).toBeVisible();
  await expect(page.getByText("Verified head", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add Variable" }).click();
  await page.getByLabel("Variable name").fill("DATABASE_URL");
  await page.getByLabel("Description (optional)").fill("Database connection.");
  await page.getByText("User-defined Value", { exact: true }).last().click();
  await page.getByLabel("Initial Value").fill("local-only-value");
  await page.getByRole("button", { name: "Add Variable" }).last().click();

  const value = page.getByLabel("DATABASE_URL Value");
  await expect(value).toHaveAttribute("type", "password");
  await expect(
    page.getByText("User-defined Value", { exact: true }).last(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Reveal DATABASE_URL" }).click();
  await expect(value).toHaveAttribute("type", "text");
  await expect(value).toHaveValue("local-only-value");

  await page.getByRole("button", { name: "Review & publish" }).click();
  await expect(page.getByRole("dialog")).toContainText("Service plaintext");
  await expect(page.getByRole("dialog")).toContainText("0 bytes");
  await expect(page.getByRole("dialog")).toContainText("fresh lane encryption");
  await page.getByRole("button", { name: "Encrypt, stage & publish" }).click();
  await expect(
    page.getByText(/Local cryptographic preview completed as rev_0185/),
  ).toBeVisible();
});

test("protected Environment editor offers local conflict choices and lane rollback", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");

  await page.getByLabel("API_ORIGIN Value").fill("https://changed.invalid");
  await page.getByRole("button", { name: "Sync & verify" }).click();
  await expect(page.getByText("Stale head: resolve locally")).toBeVisible();
  await page.getByRole("button", { name: "Keep local" }).click();
  await expect(page.getByText("Stale head: resolve locally")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Retry against verified head" })
    .click();
  await expect(
    page.getByText(/Local preview retry against verified head rev_0185/),
  ).toBeVisible();

  await page.getByRole("button", { name: "Rollback lanes" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("append-only Revision");
  await page
    .getByRole("button", { name: "Stage append-only rollback" })
    .click();
  await expect(page.getByText(/Rollback staged from rev_0183/)).toBeVisible();
  await expect(page.getByText(/current head is never rewound/i)).toBeVisible();
});

test("Environment drafts enforce unique names and preserve tombstones", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");

  await page.getByRole("button", { name: "Add Variable" }).click();
  await page.getByLabel("Variable name").fill("API_ORIGIN");
  await page.getByText("Shared Value", { exact: true }).last().click();
  await page.getByRole("button", { name: "Add Variable" }).last().click();
  await expect(page.getByRole("alert")).toContainText("already exists");

  await page.getByLabel("Variable name").fill("OPTIONAL_FLAG");
  await page.getByText("Shared Value", { exact: true }).last().click();
  await page.getByLabel("This Variable requires a Value").uncheck();
  await page
    .getByLabel("Create without a Value (absent, not an empty Value)")
    .check();
  await page.getByRole("button", { name: "Add Variable" }).last().click();
  await expect(page.getByText("OPTIONAL_FLAG", { exact: true })).toBeVisible();
  const optionalRow = page.getByTestId("environment-variable-OPTIONAL_FLAG");
  await expect(optionalRow).toContainText("Absent");
  await page.getByLabel("OPTIONAL_FLAG Value").fill("enabled");
  await page.getByRole("button", { name: "Set absent" }).click();
  await expect(optionalRow).toContainText("Absent");

  await page.getByRole("button", { name: "Delete FEATURE_GATE" }).click();
  await expect(
    page.getByText("This Variable is marked for deletion."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo delete" }).click();
  await expect(
    page.getByRole("button", { name: "Delete FEATURE_GATE" }),
  ).toBeVisible();
});
