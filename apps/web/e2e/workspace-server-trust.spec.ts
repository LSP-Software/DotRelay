import { expect, test } from "@playwright/test";
import { trustWorkspaceServer } from "./trust-server";

test("first visit pins the verified server without a prompt and survives reload", async ({
  page,
}) => {
  await page.goto("/workspace");
  await trustWorkspaceServer(page);
  await expect(page.getByTestId("trust-server-dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Trust this server" }),
  ).toHaveCount(0);
  await page.reload();
  await trustWorkspaceServer(page);
  await expect(
    page.getByRole("heading", { name: "DotRelay’s server identity changed" }),
  ).toHaveCount(0);
});
