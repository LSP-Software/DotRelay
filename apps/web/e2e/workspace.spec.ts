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

test("Devices lists enrolled Devices besides this browser", async ({
  page,
}) => {
  await page.goto("/workspace");
  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
  const enrolled = page.getByRole("table", { name: "Enrolled Devices" });
  await expect(enrolled).toContainText("00000000-0000-4000-8000-000000000041");
  await expect(enrolled).toContainText("00000000-0000-4000-8000-000000000042");
  await expect(enrolled).toContainText("Has Project access");
  await expect(enrolled).toContainText("Pending Project access");
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
      name: "Team .env files, without the headache.",
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Get started" }).click();
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
    page.getByRole("alert").getByText("Members can view this Team's Projects."),
  ).toBeVisible();
});

test("Environment archive and restore require explicit confirmation", async ({
  page,
}) => {
  await page.goto("/workspace");
  await openFirstProject(page);

  await page.getByRole("button", { name: "Archive Environment" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "History is kept. Variables stay hidden until you restore it.",
  );
  await page.getByRole("button", { name: "Confirm archive" }).click();
  await expect(
    page.getByRole("button", { name: "Restore Environment" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Restore Environment" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Restoring makes this Environment eligible for protected access again.",
  );
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(
    page.getByRole("button", { name: "Archive Environment" }),
  ).toBeVisible();
});

test("Server Profile switching asks to trust the new profile", async ({
  page,
}) => {
  await page.goto("/workspace");

  await page
    .getByRole("combobox", { name: "Server Profile" })
    .selectOption("self-hosted");
  await expect(
    page.getByRole("heading", { name: "Trust this Server Profile" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Trust this profile" }).click();
  await expect(
    page.getByRole("heading", { name: "Trust this Server Profile" }),
  ).toHaveCount(0);

  await page
    .getByRole("combobox", { name: "Server Profile" })
    .selectOption("hosted");
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
    page.getByRole("heading", { name: "Enroll this browser" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enroll browser" }),
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
  await expect(
    page.getByText("The server never sees these values."),
  ).toHaveCount(0);
  await expect(
    page.getByText("GitHub access does not grant DotRelay access."),
  ).toHaveCount(0);

  const originRow = page.getByTestId("environment-variable-API_ORIGIN");
  await page.getByLabel("API_ORIGIN Value").fill("https://changed.invalid");
  await expect(originRow).toContainText("Draft change");
  await page.getByLabel("API_ORIGIN Value").fill("");
  await expect(originRow).not.toContainText("Draft change");

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
  await expect(rollbackDialog).toContainText("This writes a new revision");
  await expect(rollbackDialog).toContainText("API_ORIGIN");
  await expect(rollbackDialog).not.toContainText("SIGNING_KEY");
  await expect(rollbackDialog).not.toContainText("https://api.acme.example");
  await expect(rollbackDialog).toContainText("••••••••");
  const showRollbackValues = page.getByRole("button", {
    name: "Show values",
  });
  await expect(showRollbackValues).toBeVisible();
  await expect(showRollbackValues).toHaveAttribute("aria-pressed", "false");

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
    page.getByText(/Rollback from rev_0183 is staged as a new revision/),
  ).toBeVisible();
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
  await expect(optionalRow).toContainText("Not set");
  await page.getByLabel("OPTIONAL_FLAG Value").fill("enabled");
  await page.getByRole("button", { name: "Set absent" }).click();
  await expect(optionalRow).toContainText("Not set");

  await page.getByRole("button", { name: "Delete FEATURE_GATE" }).click();
  await expect(
    page.getByText("This Variable is marked for deletion."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo delete" }).click();
  await expect(
    page.getByRole("button", { name: "Delete FEATURE_GATE" }),
  ).toBeVisible();
});
