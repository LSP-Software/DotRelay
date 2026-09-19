import { expect, test } from "@playwright/test";

test("the Add variable dialog lets you check the masked value before adding it", async ({
  page,
}) => {
  await page.goto("/workspace?preview=protected");
  await expect(page.getByRole("heading", { name: "Variables" })).toBeVisible();

  await page.getByRole("button", { name: "Add variable" }).click();
  const dialog = page.getByRole("dialog", { name: "Add variable" });
  await expect(dialog).toBeVisible();

  const value = dialog.getByRole("textbox", { name: "Initial value" });
  await expect(value).toHaveAttribute("type", "password");

  const reveal = dialog.getByTestId("add-variable-reveal");
  await expect(reveal).toBeVisible();
  await expect(reveal).toHaveAttribute("aria-label", "Reveal initial value");
  await expect(reveal).toHaveAttribute("aria-pressed", "false");

  await value.fill("sk-local-check-123");

  // Still masked by default: the typed value is not readable in the DOM.
  await expect(dialog).not.toContainText("sk-local-check-123");
  await expect(value).toHaveAttribute("type", "password");

  await reveal.click();
  await expect(value).toHaveAttribute("type", "text");
  await expect(value).toHaveValue("sk-local-check-123");
  await expect(reveal).toHaveAttribute("aria-pressed", "true");
  await expect(reveal).toHaveAttribute("aria-label", "Hide initial value");

  await reveal.click();
  await expect(value).toHaveAttribute("type", "password");
  await expect(reveal).toHaveAttribute("aria-pressed", "false");

  // The value typed while masked is stored exactly as typed.
  await dialog.getByLabel("Variable name").fill("CHECK_VALUE");
  await dialog.getByText("User-defined value", { exact: true }).last().click();
  await dialog.getByRole("button", { name: "Add variable" }).last().click();

  const row = page.getByTestId("environment-variable-CHECK_VALUE");
  await expect(row).toBeVisible();
  const rowValue = page.getByLabel("CHECK_VALUE value");
  await expect(rowValue).toHaveAttribute("type", "password");
  await expect(rowValue).toHaveValue("sk-local-check-123");
});
