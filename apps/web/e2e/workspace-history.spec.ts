import { expect, type Page, test } from "@playwright/test";

const openFirstProject = async (page: Page) => {
  await page.getByRole("heading", { name: "LSP-Software / DotRelay" }).click();
};

// URL updates land a beat after the state change they follow, so poll the
// address rather than asserting a one-shot string.
const expectUrl = async (page: Page, fragment: string) => {
  await expect.poll(() => page.url()).toContain(fragment);
};

test("back and forward traverse workspace views", async ({ page }) => {
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "LSP-Software / DotRelay" }),
  ).toBeVisible();
  await expectUrl(page, "view=projects");

  await page.locator("aside").getByRole("button", { name: "Team" }).click();
  await expectUrl(page, "view=team");
  await expect(page.getByText("Your team permissions")).toBeVisible();

  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
  await expectUrl(page, "view=devices");
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();

  await page.goBack();
  await expectUrl(page, "view=team");
  await expect(page.getByText("Your team permissions")).toBeVisible();

  await page.goBack();
  await expectUrl(page, "view=projects");
  await expect(
    page.getByRole("heading", { name: "LSP-Software / DotRelay" }),
  ).toBeVisible();

  await page.goForward();
  await expectUrl(page, "view=team");
  await expect(page.getByText("Your team permissions")).toBeVisible();
});

test("switching Teams is a history entry that Back and Forward traverse", async ({
  page,
}) => {
  await page.goto("/workspace");
  await expectUrl(page, "view=projects");
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();

  await page
    .locator("aside")
    .getByLabel("Team")
    .selectOption("00000000-0000-4000-8000-000000000012");
  await expectUrl(page, "team=00000000-0000-4000-8000-000000000012");
  await expect(page.getByRole("heading", { name: "Acme Labs" })).toBeVisible();

  await page.goBack();
  await expectUrl(page, "team=00000000-0000-4000-8000-000000000011");
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();

  await page.goForward();
  await expectUrl(page, "team=00000000-0000-4000-8000-000000000012");
  await expect(page.getByRole("heading", { name: "Acme Labs" })).toBeVisible();
});

test("opening Projects and switching Environments are history entries", async ({
  page,
}) => {
  await page.goto("/workspace");
  await openFirstProject(page);
  await expectUrl(page, "view=environment");
  await expectUrl(page, "environment=00000000-0000-4000-8000-000000000031");
  await expect(page.getByRole("tab", { name: "production" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("tab", { name: "staging" }).click();
  await expectUrl(page, "environment=00000000-0000-4000-8000-000000000032");

  await page.goBack();
  await expect(page.getByRole("tab", { name: "production" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expectUrl(page, "environment=00000000-0000-4000-8000-000000000031");

  await page.goBack();
  await expectUrl(page, "view=projects");
  await expect(
    page.getByRole("heading", { name: "LSP-Software / DotRelay" }),
  ).toBeVisible();

  await page.goForward();
  await expect(page.getByRole("tab", { name: "production" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("reload and shared links reopen the visible view and server", async ({
  page,
}) => {
  await page.goto("/workspace");
  await openFirstProject(page);
  await page.locator("aside").getByRole("button", { name: "Recovery" }).click();
  await expectUrl(page, "view=recovery");
  await expect(page.getByRole("heading", { name: "Recovery" })).toBeVisible();
  const recoveryUrl = page.url();

  await page.goto(recoveryUrl);
  await expectUrl(page, "view=recovery");
  await expect(page.getByRole("heading", { name: "Recovery" })).toBeVisible();

  await page
    .getByRole("combobox", { name: "Server" })
    .selectOption("self-hosted");
  await expectUrl(page, "profile=self-hosted");
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();
  // Rebinding to the new profile drops the Project/Environment params the
  // old profile owned; only the default Team of the new profile remains.
  await expect
    .poll(() => new URL(page.url()).searchParams.has("project"))
    .toBe(false);
  await expect
    .poll(() => new URL(page.url()).searchParams.has("environment"))
    .toBe(false);
  const profileUrl = page.url();

  await page.goto(profileUrl);
  await expect(page.getByRole("combobox", { name: "Server" })).toHaveValue(
    "self-hosted",
  );
  await expect(
    page.getByRole("heading", { name: "LSP Software" }),
  ).toBeVisible();
});

test("reloading Team with a selected Project reopens the Team view", async ({
  page,
}) => {
  await page.goto("/workspace");
  await openFirstProject(page);
  await page.locator("aside").getByRole("button", { name: "Team" }).click();
  await expectUrl(page, "view=team");
  await expect(page.getByText("Your team permissions")).toBeVisible();
  const teamUrl = page.url();

  await page.goto(teamUrl);
  await expectUrl(page, "view=team");
  await expect(page.getByText("Your team permissions")).toBeVisible();
  // The selected Project survives the reload; the URL keeps naming it.
  await expect
    .poll(() => new URL(page.url()).searchParams.has("project"))
    .toBe(true);
});

test("reloading the Projects, Team, and Devices views reopens them", async ({
  page,
}) => {
  await page.goto("/workspace");
  await expectUrl(page, "view=projects");
  const projectsUrl = page.url();
  await page.goto(projectsUrl);
  await expectUrl(page, "view=projects");
  await expect(
    page.getByRole("heading", { name: "LSP-Software / DotRelay" }),
  ).toBeVisible();

  await page.locator("aside").getByRole("button", { name: "Team" }).click();
  await expectUrl(page, "view=team");
  const teamUrl = page.url();
  await page.goto(teamUrl);
  await expectUrl(page, "view=team");
  await expect(page.getByText("Your team permissions")).toBeVisible();

  await page.locator("aside").getByRole("button", { name: "Devices" }).click();
  await expectUrl(page, "view=devices");
  const devicesUrl = page.url();
  await page.goto(devicesUrl);
  await expectUrl(page, "view=devices");
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
});

test("links to deleted resources recover instead of blanking the page", async ({
  page,
}) => {
  await page.goto(
    "/workspace?profile=hosted&team=00000000-0000-4000-8000-000000000011&project=00000000-0000-4000-8000-000000000099&view=environment",
  );
  await expect(page.getByTestId("workspace-missing-resource")).toBeVisible();
  await expect(page.getByTestId("workspace-missing-resource")).toContainText(
    "That project is no longer available",
  );
  await expect(
    page.getByRole("heading", { name: "LSP-Software / DotRelay" }),
  ).toBeVisible();

  await page.goto(
    "/workspace?profile=hosted&team=00000000-0000-4000-8000-000000000011&project=00000000-0000-4000-8000-000000000021&environment=00000000-0000-4000-8000-000000000099&view=environment",
  );
  await expect(page.getByTestId("workspace-missing-resource")).toBeVisible();
  await expect(page.getByTestId("workspace-missing-resource")).toContainText(
    "That environment is no longer available",
  );
  await expect(page.getByRole("tab", { name: "production" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("deleted teams recover to the first team", async ({ page }) => {
  await page.goto(
    "/workspace?profile=hosted&team=deleted-team&project=00000000-0000-4000-8000-000000000021&view=environment",
  );
  await expect(page.getByTestId("workspace-missing-resource")).toBeVisible();
  await expect(page.getByTestId("workspace-missing-resource")).toContainText(
    "That team is no longer available",
  );
  await expect(
    page.getByRole("heading", { name: "LSP-Software / DotRelay" }),
  ).toBeVisible();
});

test("a project link without a team opens the project from its own team", async ({
  page,
}) => {
  await page.goto(
    "/workspace?profile=hosted&project=00000000-0000-4000-8000-000000000022&view=environment",
  );
  await expect(
    page.getByRole("heading", { name: "acme / widget" }),
  ).toBeVisible();
  await expect(page.getByTestId("workspace-missing-resource")).toHaveCount(0);
  await expectUrl(page, "team=00000000-0000-4000-8000-000000000012");
  await expect(page.getByRole("tab", { name: "default" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("history navigation keeps dirty drafts for the return trip", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  const editor = page.getByTestId("editor-context-active");
  await editor.getByLabel("API_ORIGIN Value").fill("draft-value");
  await expect(
    editor.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");

  await page.locator("aside").getByRole("button", { name: "Projects" }).click();
  await expect(page.getByTestId("switch-draft-prompt")).toHaveCount(0);
  await expectUrl(page, "view=projects");

  await page.goBack();
  const restored = page.getByTestId("editor-context-active");
  await expectUrl(page, "view=environment");
  await expect(
    restored.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");
  await restored.getByRole("button", { name: "Reveal API_ORIGIN" }).click();
  await expect(restored.getByLabel("API_ORIGIN Value")).toHaveValue(
    "draft-value",
  );
});

test("a history rebind with a dirty draft prompts and Stay returns to the entry left", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await page
    .getByRole("combobox", { name: "Server" })
    .selectOption("self-hosted");
  // The protected preview reopens the first Project after the rebind; wait
  // for it so the draft lands in a stable Environment.
  await expect(page.getByRole("tab", { name: "production" })).toBeVisible();
  await openFirstProject(page);
  const editor = page.getByTestId("editor-context-active");
  await editor.getByLabel("API_ORIGIN Value").fill("draft-value");
  await expect(
    editor.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");

  // One Back step reaches the entry left behind (the pre-rebind view); the
  // browser's own initial entry sits before the app's history, so a second
  // step would leave the workspace.
  await page.goBack();
  const prompt = page.getByTestId("switch-draft-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("Switch servers?");

  await page.getByRole("button", { name: "Stay" }).click();
  await expect(page.getByRole("combobox", { name: "Server" })).toHaveValue(
    "self-hosted",
  );
  await expectUrl(page, "profile=self-hosted");

  await page.goForward();
  const restored = page.getByTestId("editor-context-active");
  await expectUrl(page, "profile=self-hosted");
  await expect(
    restored.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");
});

test("discarding from a history rebind prompt commits the rebind", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await page
    .getByRole("combobox", { name: "Server" })
    .selectOption("self-hosted");
  await expect(page.getByRole("tab", { name: "production" })).toBeVisible();
  await openFirstProject(page);
  const editor = page.getByTestId("editor-context-active");
  await editor.getByLabel("API_ORIGIN Value").fill("draft-value");
  await expect(
    editor.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");

  // One Back step reaches the hosted entry left behind; the protected
  // preview then reopens the first Project for it.
  await page.goBack();
  const prompt = page.getByTestId("switch-draft-prompt");
  await expect(prompt).toBeVisible();
  await page.getByTestId("switch-discard-draft").click();

  await expect(page.getByRole("combobox", { name: "Server" })).toHaveValue(
    "hosted",
  );
  await expectUrl(page, "profile=hosted");
  await expectUrl(page, "view=environment");
  await expect(
    page.getByRole("heading", { name: "LSP-Software / DotRelay" }),
  ).toBeVisible();
});
