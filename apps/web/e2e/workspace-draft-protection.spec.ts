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

const beforeUnloadPrevented = (page: Page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

const readBrowserStorage = (page: Page) =>
  page.evaluate(() => {
    const parts: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null) continue;
      parts.push(key, localStorage.getItem(key) ?? "");
    }
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key === null) continue;
      parts.push(key, sessionStorage.getItem(key) ?? "");
    }
    return parts.join("\n");
  });

test("navigating among workspace views and returning preserves the draft", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);

  for (const view of ["Projects", "Team", "Devices", "Recovery"]) {
    await page.locator("aside").getByRole("button", { name: view }).click();
    await expect(page.getByTestId("editor-context-active")).toContainText(
      "Draft change",
    );
  }

  await page
    .locator("aside")
    .getByRole("button", { name: "LSP-Software / DotRelay" })
    .click();
  const editor = activeEditor(page);
  await expect(
    editor.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");
  await editor.getByRole("button", { name: "Reveal API_ORIGIN" }).click();
  await expect(editor.getByLabel("API_ORIGIN Value")).toHaveValue(
    "draft-value",
  );
});

test("reloading with an unpublished draft warns and keeps it when cancelled", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);

  expect(await beforeUnloadPrevented(page)).toBe(true);

  const dialogPromise = page.waitForEvent("dialog");
  void page.reload().catch(() => undefined);
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();

  const editor = activeEditor(page);
  await expect(
    editor.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");
  await editor.getByRole("button", { name: "Reveal API_ORIGIN" }).click();
  await expect(editor.getByLabel("API_ORIGIN Value")).toHaveValue(
    "draft-value",
  );
});

test("a confirmed reload discards the warned-about draft", async ({ page }) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);

  const dialogPromise = page.waitForEvent("dialog");
  const reloadPromise = page.reload().catch(() => undefined);
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
  await reloadPromise;

  await expect(page.getByTestId("editor-context-active")).toBeVisible();
  await expect(
    activeEditor(page).getByTestId("environment-variable-API_ORIGIN"),
  ).not.toContainText("Draft change");
});

test("reloading without an unpublished draft proceeds without a warning", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await expect(
    activeEditor(page).getByTestId("environment-variable-API_ORIGIN"),
  ).toBeVisible();

  expect(await beforeUnloadPrevented(page)).toBe(false);
  await page.reload();
  await expect(
    page
      .getByTestId("editor-context-active")
      .getByTestId("environment-variable-API_ORIGIN"),
  ).toBeVisible();
});

test("the discard prompt names the affected Environment and Variable changes", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);
  await activeEditor(page)
    .getByRole("button", { name: "Delete FEATURE_GATE" })
    .click();

  await page.getByRole("tab", { name: "staging" }).click();
  const prompt = page.getByTestId("switch-draft-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("production");
  await expect(prompt).toContainText("API_ORIGIN");
  await expect(prompt).toContainText("FEATURE_GATE");

  await page.getByTestId("switch-discard-draft").click();
  const staging = activeEditor(page);
  await expect(
    staging.getByTestId("environment-variable-API_ORIGIN"),
  ).not.toContainText("Draft change");
});

test("staying on the profile keeps an unpublished draft", async ({ page }) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);

  await page
    .getByRole("combobox", { name: "Server Profile" })
    .selectOption("self-hosted");
  const prompt = page.getByTestId("switch-draft-prompt");
  await expect(prompt).toBeVisible();
  await page.getByRole("button", { name: "Stay" }).click();

  await expect(prompt).toHaveCount(0);
  const editor = activeEditor(page);
  await expect(
    editor.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");
  expect(await beforeUnloadPrevented(page)).toBe(true);
});

test("switching profiles with drafts names them and discards on explicit choice", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);

  await page.getByRole("tab", { name: "staging" }).click();
  await page.getByTestId("switch-keep-draft").click();
  const staging = activeEditor(page);
  await staging.getByLabel("API_ORIGIN Value").fill("staging-draft");

  await page
    .getByRole("combobox", { name: "Server Profile" })
    .selectOption("self-hosted");
  const prompt = page.getByTestId("switch-draft-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("Hosted / London");
  await expect(prompt).toContainText("Self-hosted / eu-1");

  await page.getByTestId("switch-discard-draft").click();

  await expect(
    page.getByRole("combobox", { name: "Server Profile" }),
  ).toHaveValue("self-hosted");
  const editor = activeEditor(page);
  await expect(
    editor.getByTestId("environment-variable-API_ORIGIN"),
  ).not.toContainText("Draft change");
  await editor.getByRole("button", { name: "Reveal API_ORIGIN" }).click();
  await expect(editor.getByLabel("API_ORIGIN Value")).toHaveValue("");
  expect(await beforeUnloadPrevented(page)).toBe(false);
});

test("a profile switch warns even when only a retained draft is dirty", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  await startDraft(page);

  await page.getByRole("tab", { name: "staging" }).click();
  await page.getByTestId("switch-keep-draft").click();

  await page
    .getByRole("combobox", { name: "Server Profile" })
    .selectOption("self-hosted");
  const prompt = page.getByTestId("switch-draft-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("production");
  await page.getByRole("button", { name: "Stay" }).click();
  await expect(prompt).toHaveCount(0);

  await page.getByRole("tab", { name: "production" }).click();
  const production = activeEditor(page);
  await expect(
    production.getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");
});

test("unpublished draft Values are not written to browser storage", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await openFirstProject(page);
  const secret = "plain-draft-value-105";
  await activeEditor(page).getByLabel("API_ORIGIN Value").fill(secret);
  await expect(
    activeEditor(page).getByTestId("environment-variable-API_ORIGIN"),
  ).toContainText("Draft change");

  const stored = await readBrowserStorage(page);
  expect(stored).not.toContain(secret);
});
