import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalDecode,
  canonicalEncode,
  parseProtocolObject,
} from "@dotrelay/contracts";
import { chromium, type Page } from "@playwright/test";
import type { BrowserVectorEntry } from "./browser-vector-runner";
import { bytesFromHex, hexFromBytes } from "./vector-hex";

const browserFixtures: { fixtures: BrowserVectorEntry[] } = await Bun.file(
  "test-vectors/e2ee/v3/browser-bun.json",
).json();

const protocolFixtures = async (): Promise<BrowserVectorEntry[]> => {
  const objects = await Bun.file("test-vectors/e2ee/v3/objects.json").json();
  const conditional = await Bun.file(
    "test-vectors/e2ee/v3/conditional.json",
  ).json();
  return [...objects.vectors, ...conditional.vectors].map(
    (vector: { canonicalHex: string }) => ({
      hex: vector.canonicalHex,
      protocolObject: true,
    }),
  );
};

type BrowserRunner = Readonly<{
  readonly dotRelayCanonicalHexes: (
    entries: readonly BrowserVectorEntry[],
  ) => string[];
}>;

const evaluateCanonicalHexes = async (
  page: Page,
  entries: readonly BrowserVectorEntry[],
): Promise<string[]> =>
  page.evaluate(
    (vectors) =>
      (globalThis as unknown as BrowserRunner).dotRelayCanonicalHexes(vectors),
    entries,
  );

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
      const fixtures = [
        ...browserFixtures.fixtures,
        ...(await protocolFixtures()),
      ];
      const browserHex = await evaluateCanonicalHexes(page, fixtures);
      const bunHex = fixtures.map(({ hex, protocolObject }) => {
        const bytes = bytesFromHex(hex);
        const value = protocolObject
          ? parseProtocolObject(bytes)
          : canonicalDecode(bytes);
        return hexFromBytes(canonicalEncode(value));
      });

      // Browser output must parse and canonicalize in Bun; Bun output must do the same in Chromium.
      expect(browserHex).toEqual(
        bunHex.map((hex) =>
          hexFromBytes(canonicalEncode(canonicalDecode(bytesFromHex(hex)))),
        ),
      );
      const browserFromBunHex = await evaluateCanonicalHexes(
        page,
        bunHex.map((hex, index) => ({
          hex,
          ...(fixtures[index]?.protocolObject ? { protocolObject: true } : {}),
        })),
      );
      expect(browserFromBunHex).toEqual(bunHex);
    } finally {
      await browser.close();
    }
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
});
