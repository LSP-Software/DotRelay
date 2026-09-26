import { expect, type Page } from "@playwright/test";

// First use records the verified server identity automatically.
export const trustWorkspaceServer = async (page: Page) => {
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("heading", { name: "Checking this server" }),
  ).toHaveCount(0, { timeout: 15_000 });
};
