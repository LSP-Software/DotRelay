import { expect, type Page } from "@playwright/test";

// Records the trust decision for the workspace's configured server so specs
// can reach the protected surfaces. Call it while the Projects view or an
// Environment is on screen, where the trust gate renders. A decision this
// browser already recorded for the deployment's origin and server identity is
// recognized, so the helper is a no-op for a trusted workspace.
export const trustWorkspaceServer = async (page: Page) => {
  const gate = page.getByRole("heading", { name: "Trust this server" });
  // Settle the boundary first: while the workspace is still loading, neither
  // a verified profile nor its stored trust decision is on screen.
  await expect(page.getByTestId("workspace-loading")).toBeHidden({
    timeout: 15_000,
  });
  // Give the stored-pin check for the just-verified profile time to settle:
  // an untrusted profile keeps the gate, a trusted one drops it.
  await page.waitForTimeout(500);
  if ((await gate.count()) === 0) return;
  await page.getByRole("button", { name: "Trust this server" }).click();
  await expect(page.getByTestId("trust-server-dialog")).toBeVisible();
  await page.getByTestId("trust-server-confirm").click();
  await expect(gate).toHaveCount(0);
};
