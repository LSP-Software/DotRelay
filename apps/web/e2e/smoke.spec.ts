import { expect, test } from "@playwright/test";

test("production-shaped web surface responds", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "DotRelay" })).toBeVisible();
  await expect(page.getByText("Foundation scaffold ready.")).toBeVisible();
});
