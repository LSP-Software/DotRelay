import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDecode, canonicalEncode } from "@dotrelay/contracts";
import { chromium } from "@playwright/test";

const fixtures: { fixtures: Array<{ hex: string }> } = await Bun.file(
  "test-vectors/e2ee/v2/browser-bun.json",
).json();

const bytesFromHex = (value: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new Error("invalid vector hex");
  return Uint8Array.from(
    value.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
};

const hexFromBytes = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

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
      const bunHex = fixtures.fixtures.map((fixture: { hex: string }) =>
        hexFromBytes(
          canonicalEncode(canonicalDecode(bytesFromHex(fixture.hex))),
        ),
      );

      // Browser output must parse and canonicalize in Bun; Bun output must do the same in Chromium.
      expect(browserHex).toEqual(
        bunHex.map((hex) =>
          hexFromBytes(canonicalEncode(canonicalDecode(bytesFromHex(hex)))),
        ),
      );
      const browserFromBunHex = await page.evaluate(
        (entries) => {
          return (
            globalThis as unknown as {
              dotRelayCanonicalHexes: (
                values: Array<{ hex: string }>,
              ) => string[];
            }
          ).dotRelayCanonicalHexes(entries);
        },
        bunHex.map((hex) => ({ hex })),
      );
      expect(browserFromBunHex).toEqual(bunHex);
    } finally {
      await browser.close();
    }
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
});
