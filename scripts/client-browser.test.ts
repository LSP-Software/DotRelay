import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";

type ClientBrowserRunner = Readonly<{
  readonly dotRelayClientWrapRoundTrip: () => Promise<{
    readonly plaintextLength: number;
    readonly ciphertextLength: number;
    readonly matches: boolean;
  }>;
}>;

const evaluateWrapRoundTrip = async (page: Page) =>
  page.evaluate(() =>
    (
      globalThis as unknown as ClientBrowserRunner
    ).dotRelayClientWrapRoundTrip(),
  );

test("Chromium and Bun preserve client device-bundle wrapping", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "dotrelay-client-"));
  try {
    const build = await Bun.build({
      entrypoints: ["scripts/client-browser-runner.ts"],
      format: "iife",
      outdir: outputDirectory,
      target: "browser",
    });
    expect(build.success).toBe(true);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto("https://example.com");
      await page.addScriptTag({
        path: join(outputDirectory, "client-browser-runner.js"),
      });
      const browserResult = await evaluateWrapRoundTrip(page);
      expect(browserResult.matches).toBe(true);
      expect(browserResult.plaintextLength).toBeGreaterThan(0);
      expect(browserResult.ciphertextLength).toBeGreaterThan(
        browserResult.plaintextLength,
      );
    } finally {
      await browser.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
