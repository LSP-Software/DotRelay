import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const fixtures = await Bun.file("test-vectors/e2ee/v2/browser-bun.json").json();

test("Chromium and Bun preserve the frozen protocol bytes", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "dotrelay-contracts-"));
  try {
    const build = await Bun.build({
      entrypoints: ["scripts/browser-vector-runner.ts"],
      format: "iife",
      outdir: outputDirectory,
      target: "browser",
    });
    expect(build.success).toBe(true);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.addScriptTag({
        path: join(outputDirectory, "browser-vector-runner.js"),
      });
      const browserHex = await page.evaluate((vectors) => {
        return (
          globalThis as unknown as {
            dotRelayCanonicalHexes: (
              entries: Array<{ hex: string }>,
            ) => string[];
          }
        ).dotRelayCanonicalHexes(vectors.fixtures);
      }, fixtures);
      expect(browserHex).toEqual(
        fixtures.fixtures.map((fixture: { hex: string }) => fixture.hex),
      );
    } finally {
      await browser.close();
    }
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
});
