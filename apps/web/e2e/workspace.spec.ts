import { expect, type Page, test } from "@playwright/test";

const openFirstProject = async (page: Page) => {
  await page.getByRole("heading", { name: "LSP-Software / DotRelay" }).click();
};

test("workspace shows a copyable CLI setup command after opening Devices", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/workspace");
  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
  await expect(page.getByTestId("cli-setup-command")).toContainText(
    "dotrelay setup",
  );
  await page.getByRole("button", { name: "Copy command" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
});

test("Devices lists other devices besides this browser", async ({ page }) => {
  await page.goto("/workspace");
  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
  const devices = page.getByRole("table", { name: "Your devices" });
  await expect(devices).toContainText("00000000-0000-4000-8000-000000000041");
  await expect(devices).toContainText("00000000-0000-4000-8000-000000000042");
  await expect(devices).toContainText("Has project access");
  await expect(devices).toContainText("Waiting for project keys");
});

test("device approval page asks to allow the CLI", async ({ page }) => {
  await page.goto("/device?user_code=ABCD-EFGH");
  await expect(
    page.getByRole("heading", { name: "Allow this CLI?" }),
  ).toBeVisible();
  await expect(page.getByText("ABCD-EFGH")).toBeVisible();
});

test("landing page leads to GitHub sign-in without implying GitHub grants access", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "Share your .env files, with your team and your machines.",
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  await expect(
    page.getByText("Signing in doesn't grant access to any project's values."),
  ).toBeVisible();
});

test("the Team menu shows the current Team and lets you switch", async ({
  page,
}) => {
  await page.goto("/workspace");
  await expect(
    page.getByRole("combobox", { name: "Team" }).first(),
  ).toHaveValue("00000000-0000-4000-8000-000000000011");
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Team" })
    .first()
    .selectOption("Acme Labs");
  await expect(page.getByRole("heading", { name: "Acme Labs" })).toBeVisible();
  await expect(
    page.locator("main").getByRole("button", { name: "acme / widget" }),
  ).toBeVisible();
});

test("role-aware administration and invitations expose pending key grants", async ({
  page,
}) => {
  await page.goto("/workspace");
  await page.locator("aside").getByRole("button", { name: "Team" }).click();

  await page
    .getByRole("combobox", { name: "Preview role" })
    .selectOption("OWNER");
  await page.getByRole("button", { name: "Invite member" }).click();
  await page.getByLabel("GitHub user ID").fill("github:18473192");
  await page.getByRole("button", { name: "Create invitation" }).click();

  await expect(page.getByText("github:18473192")).toBeVisible();
  await expect(page.getByText("Waiting for encryption keys")).toBeVisible();

  await page
    .getByRole("combobox", { name: "Preview role" })
    .selectOption("MEMBER");
  await expect(
    page.getByRole("button", { name: "Invite member" }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole("alert")
      .getByText(
        "Members can view this team's projects, read shared values, and manage their own values.",
      ),
  ).toBeVisible();
});

test("Environment archive and restore require explicit confirmation", async ({
  page,
}) => {
  await page.goto("/workspace");
  await openFirstProject(page);

  await page.getByRole("button", { name: "Archive environment" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Archiving hides this environment's variables but keeps its history. Restore it to access the variables again.",
  );
  await page.getByRole("button", { name: "Confirm archive" }).click();
  await expect(
    page.getByRole("button", { name: "Restore environment" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Restore environment" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Restoring lets devices with the required keys access this environment again. It does not grant new permissions.",
  );
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(
    page.getByRole("button", { name: "Archive environment" }),
  ).toBeVisible();
});

test("switching servers asks to trust the new server", async ({ page }) => {
  await page.goto("/workspace");

  await page
    .getByRole("combobox", { name: "Server" })
    .selectOption("self-hosted");
  await expect(
    page.getByRole("heading", { name: "Trust this server" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Trust this server" }).click();
  await expect(
    page.getByRole("heading", { name: "Trust this server" }),
  ).toHaveCount(0);

  await page.getByRole("combobox", { name: "Server" }).selectOption("hosted");
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();
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
    page.getByRole("dialog").getByRole("button", { name: "Team" }),
  ).toBeVisible();
});

test("missing Device setup has one action and does not dump problem codes", async ({
  page,
}) => {
  await page.goto("/workspace");
  await openFirstProject(page);

  await expect(
    page.getByRole("heading", { name: "Set up this browser" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Set up browser" }),
  ).toBeVisible();
  await expect(page.getByTestId("cli-setup-command")).toContainText(
    "dotrelay setup",
  );
  await expect(
    page.getByRole("button", { name: "Copy command" }),
  ).toBeVisible();
  await expect(page.getByText("crypto_provider_unavailable")).toHaveCount(0);
  await expect(page.getByText("Protected content is unavailable")).toHaveCount(
    0,
  );
  await expect(page.getByText("DATABASE_URL=", { exact: false })).toHaveCount(
    0,
  );
});

test("unsupported cryptography explains how to continue", async ({ page }) => {
  await page.goto("/workspace?preview=no-crypto");
  await expect(
    page.getByRole("heading", { name: "This browser can't decrypt variables" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy CLI command" }),
  ).toBeVisible();
  await expect(page.getByTestId("cli-setup-command")).toContainText(
    "dotrelay setup",
  );
  await expect(
    page.getByRole("button", { name: "Copy command" }),
  ).toBeVisible();
});

test("protected Environment editor keeps Values masked and previews a local draft", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");

  await expect(page.getByRole("heading", { name: "Variables" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(page.getByText("rev_0184", { exact: true })).toBeVisible();
  await expect(page.getByText("rev_0183", { exact: true })).toBeVisible();
  // The development preview has no verified wire record, so its history is
  // honest about the unavailable time and author metadata.
  await expect(
    page.getByText("Time unavailable", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Author unavailable", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("The server never sees these values."),
  ).toHaveCount(0);
  await expect(
    page.getByText("GitHub access does not grant DotRelay access."),
  ).toHaveCount(0);

  const originRow = page.getByTestId("environment-variable-API_ORIGIN");
  await page.getByLabel("API_ORIGIN value").fill("https://changed.invalid");
  await expect(originRow).toContainText("Draft change");
  await page.getByLabel("API_ORIGIN value").fill("");
  await expect(originRow).not.toContainText("Draft change");

  await page.getByRole("button", { name: "Add variable" }).click();
  await page.getByLabel("Variable name").fill("DATABASE_URL");
  await page.getByLabel("Description (optional)").fill("Database connection.");
  await page.getByText("User-defined value", { exact: true }).last().click();
  await page.getByLabel("Initial value").fill("local-only-value");
  await page.getByRole("button", { name: "Add variable" }).last().click();

  const value = page.getByLabel("DATABASE_URL value");
  await expect(value).toHaveAttribute("type", "password");
  await expect(
    page.getByText("User-defined value", { exact: true }).last(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Reveal DATABASE_URL" }).click();
  await expect(value).toHaveAttribute("type", "text");
  await expect(value).toHaveValue("local-only-value");

  await page.getByRole("button", { name: "Save changes" }).click();
  const reviewDialog = page.getByRole("dialog", { name: "Save changes" });
  await expect(reviewDialog).toContainText("DATABASE_URL");
  await expect(reviewDialog).not.toContainText("local-only-value");
  await expect(reviewDialog).toContainText("••••••••");
  const showReviewValues = page.getByRole("button", { name: "Show values" });
  await expect(showReviewValues).toBeVisible();
  await expect(showReviewValues).toHaveAttribute("aria-pressed", "false");

  await showReviewValues.click();
  await expect(reviewDialog).toContainText("local-only-value");
  await expect(
    page.getByRole("button", { name: "Hide values" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(reviewDialog).not.toContainText("local-only-value");
  await expect(showReviewValues).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Local preview saved as rev_0185/)).toBeVisible();
});

test("protected Environment editor offers lane rollback", async ({ page }) => {
  await page.goto("/workspace?preview=protected");

  await page.getByRole("button", { name: "Rollback" }).first().click();
  const rollbackDialog = page.getByRole("dialog", { name: "Rollback" });
  await expect(rollbackDialog).toContainText(
    "Publishing creates a new revision without deleting the current one",
  );
  // The dialog identifies the selected target and the rollback consequence.
  await expect(
    rollbackDialog.getByText("rev_0183", { exact: true }),
  ).toBeVisible();
  await expect(rollbackDialog).toContainText(
    "Staging puts the selected values in your draft",
  );
  await expect(rollbackDialog).toContainText("1 of 1 variables selected");
  await expect(rollbackDialog).toContainText("API_ORIGIN");
  await expect(rollbackDialog).not.toContainText("SIGNING_KEY");
  await expect(rollbackDialog).not.toContainText("https://api.acme.example");
  await expect(rollbackDialog).toContainText("••••••••");
  const showRollbackValues = page.getByRole("button", {
    name: "Show values",
  });
  await expect(showRollbackValues).toBeVisible();
  await expect(showRollbackValues).toHaveAttribute("aria-pressed", "false");

  const rollbackLane = rollbackDialog.getByRole("checkbox").first();
  await rollbackLane.uncheck();
  await expect(rollbackDialog).toContainText("0 of 1 variables selected");
  await expect(
    rollbackDialog.getByRole("button", { name: "Stage rollback" }),
  ).toBeDisabled();
  await rollbackLane.check();

  await showRollbackValues.click();
  await expect(rollbackDialog).toContainText("https://api.acme.example");
  await expect(
    page.getByRole("button", { name: "Hide values" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Rollback" }).first().click();
  await expect(rollbackDialog).not.toContainText("https://api.acme.example");
  await expect(rollbackDialog).toContainText("••••••••");
  await expect(showRollbackValues).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Stage rollback" }).click();
  await expect(
    page.getByText(/Values from rev_0183 are in your draft/),
  ).toBeVisible();
});

test("owners can create an Environment from an existing one", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");

  await page.getByRole("button", { name: "New Environment" }).click();
  await page.getByLabel("Label").fill("development");
  await expect(page.getByLabel("Base Environment")).toHaveValue(
    "00000000-0000-4000-8000-000000000031",
  );
  await page
    .getByRole("radio", { name: "Leave blank for SIGNING_KEY" })
    .check();
  await page
    .getByRole("radio", { name: "Don't include for FEATURE_GATE" })
    .check();
  await page.getByRole("button", { name: "Create Environment" }).click();

  await expect(page.getByRole("tab", { name: "development" })).toBeVisible();
  const activeEditor = page.getByTestId("editor-context-active");
  await expect(
    activeEditor.getByTestId("environment-variable-API_ORIGIN"),
  ).toBeVisible();
  await expect(
    activeEditor.getByTestId("environment-variable-SIGNING_KEY"),
  ).toBeVisible();
  await expect(
    activeEditor.getByTestId("environment-variable-FEATURE_GATE"),
  ).toHaveCount(0);
});

test("Members cannot create Environments", async ({ page }) => {
  await page.goto("/workspace");
  await page.locator("aside").getByRole("button", { name: "Team" }).click();
  await page
    .getByRole("combobox", { name: "Preview Membership role" })
    .selectOption("MEMBER");
  await page.locator("aside").getByRole("button", { name: "Projects" }).click();
  await openFirstProject(page);
  await expect(
    page.getByRole("button", { name: "New Environment" }),
  ).toBeDisabled();
});

test("Environment drafts enforce unique names and preserve tombstones", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");

  await page.getByRole("button", { name: "Add variable" }).click();
  await page.getByLabel("Variable name").fill("API_ORIGIN");
  await page.getByText("Shared value", { exact: true }).last().click();
  await page.getByRole("button", { name: "Add variable" }).last().click();
  await expect(page.getByRole("alert")).toContainText("already exists");

  await page.getByLabel("Variable name").fill("OPTIONAL_FLAG");
  await page.getByText("Shared value", { exact: true }).last().click();
  await page.getByLabel("Require a value").uncheck();
  await page
    .getByLabel("Leave the value unset, rather than save an empty string")
    .check();
  await page.getByRole("button", { name: "Add variable" }).last().click();
  await expect(page.getByText("OPTIONAL_FLAG", { exact: true })).toBeVisible();
  const optionalRow = page.getByTestId("environment-variable-OPTIONAL_FLAG");
  await expect(optionalRow).toContainText("Not set");
  await page.getByLabel("OPTIONAL_FLAG value").fill("enabled");
  await page.getByRole("button", { name: "Unset value" }).click();
  await expect(optionalRow).toContainText("Not set");

  await page.getByRole("button", { name: "Delete FEATURE_GATE" }).click();
  await expect(
    page.getByText("This variable is marked for deletion."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo delete" }).click();
  await expect(
    page.getByRole("button", { name: "Delete FEATURE_GATE" }),
  ).toBeVisible();
});
