import { expect, type Page, test } from "@playwright/test";

const openFirstProject = async (page: Page) => {
  await page.getByRole("heading", { name: "LSP-Software / DotRelay" }).click();
};

const activeEditor = (page: Page) => page.getByTestId("editor-context-active");

const startDraft = async (page: Page) => {
  const editor = activeEditor(page);
  await editor.getByLabel("API_ORIGIN Value").fill("draft-value");
  await expect(
    editor.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");
};

test("keeping a draft on Environment switch restores it on return", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);

  await page.getByRole("tab", { name: "staging" }).click();
  await expect(page.getByTestId("switch-draft-prompt")).toBeVisible();
  await page.getByTestId("switch-keep-draft").click();

  const staging = activeEditor(page);
  await expect(
    staging.getByTestId("environment-variable-API_ORIGIN"),
  ).not.toContainText("Draft change");
  await staging.getByRole("button", { name: "Reveal API_ORIGIN" }).click();
  await expect(staging.getByLabel("API_ORIGIN Value")).toHaveValue("");

  await page.getByRole("tab", { name: "production" }).click();
  const production = activeEditor(page);
  await expect(
    production.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");
  await production.getByRole("button", { name: "Reveal API_ORIGIN" }).click();
  await expect(production.getByLabel("API_ORIGIN Value")).toHaveValue(
    "draft-value",
  );
});

test("discarding a draft on Environment switch abandons it everywhere", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);

  await page.getByRole("tab", { name: "staging" }).click();
  await expect(page.getByTestId("switch-draft-prompt")).toBeVisible();
  await page.getByTestId("switch-discard-draft").click();

  const staging = activeEditor(page);
  await expect(
    staging.getByTestId("environment-variable-API_ORIGIN"),
  ).not.toContainText("Draft change");
  await staging.getByRole("button", { name: "Reveal API_ORIGIN" }).click();
  await expect(staging.getByLabel("API_ORIGIN Value")).toHaveValue("");

  await page.getByRole("tab", { name: "production" }).click();
  const production = activeEditor(page);
  await expect(
    production.getByTestId("environment-variable-API_ORIGIN"),
  ).not.toContainText("Draft change");
  await production.getByRole("button", { name: "Reveal API_ORIGIN" }).click();
  await expect(production.getByLabel("API_ORIGIN Value")).toHaveValue("");
});

test("cancelling the switch prompt keeps the current Environment and draft", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);

  await page.getByRole("tab", { name: "staging" }).click();
  await expect(page.getByTestId("switch-draft-prompt")).toBeVisible();
  await page
    .getByTestId("switch-draft-prompt")
    .getByRole("button", { name: "Cancel" })
    .click();

  await expect(page.getByTestId("switch-draft-prompt")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "staging" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  await expect(page.getByRole("tab", { name: "production" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const production = activeEditor(page);
  await expect(
    production.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");
});

test("switching Environments without unsaved changes does not prompt", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);

  await page.getByRole("tab", { name: "staging" }).click();
  await expect(page.getByTestId("switch-draft-prompt")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "staging" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const staging = activeEditor(page);
  await expect(
    staging.getByTestId("environment-variable-API_ORIGIN"),
  ).not.toContainText("Draft change");
});

test("a retained draft cannot be published from another Environment", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);

  await page.getByRole("tab", { name: "staging" }).click();
  await expect(page.getByTestId("switch-draft-prompt")).toBeVisible();
  await page.getByTestId("switch-keep-draft").click();

  const staging = activeEditor(page);
  await expect(
    staging.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();

  await page.getByRole("tab", { name: "production" }).click();
  const production = activeEditor(page);
  await expect(
    production.getByRole("button", { name: "Save changes" }),
  ).toBeEnabled();
});
