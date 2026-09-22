import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";

type ClientBrowserRunner = Readonly<{
  readonly dotRelayClientAccountKeyRoundTrip: () => Promise<{
    readonly accountMasterKeyLength: number;
    readonly recoveryCodeCharacters: number;
    readonly codeRoundTripMatches: boolean;
    readonly accountMasterKeyMatches: boolean;
  }>;
  readonly dotRelayClientWrapRoundTrip: () => Promise<{
    readonly plaintextLength: number;
    readonly ciphertextLength: number;
    readonly matches: boolean;
  }>;
}>;

const evaluate = async <Result extends object>(
  page: Page,
  name: keyof ClientBrowserRunner,
): Promise<Result> =>
  page.evaluate(async (method) => {
    const runner = (globalThis as unknown as ClientBrowserRunner)[
      method as keyof ClientBrowserRunner
    ];
    if (typeof runner !== "function")
      throw new Error(`client bundle is missing ${method}`);
    return runner() as unknown as Result;
  }, name);

const buildRunner = async (outputDirectory: string) => {
  const build = await Bun.build({
    entrypoints: ["scripts/client-browser-runner.ts"],
    format: "iife",
    outdir: outputDirectory,
    target: "browser",
  });
  expect(build.success).toBe(true);
  return join(outputDirectory, "client-browser-runner.js");
};

test("Chromium and Bun preserve client device-bundle wrapping", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "dotrelay-client-"));
  try {
    const bundlePath = await buildRunner(outputDirectory);
    // The password-wrapper KDF must be part of the production browser bundle:
    // without it a DEVICE could never unlock a PASSWORD Account Key Wrapper
    // in the browser, and the bundle would silently omit the Argon2 module
    // instead of failing here. "maxmem" occurs only in the Argon2
    // implementation, not in client or contracts code.
    const bundleSource = await Bun.file(bundlePath).text();
    expect(bundleSource).toContain("maxmem");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto("https://example.com");
      await page.addScriptTag({ path: bundlePath });
      const wrap = await evaluate<{
        readonly matches: boolean;
        readonly plaintextLength: number;
        readonly ciphertextLength: number;
      }>(page, "dotRelayClientWrapRoundTrip");
      expect(wrap.matches).toBe(true);
      expect(wrap.plaintextLength).toBeGreaterThan(0);
      expect(wrap.ciphertextLength).toBeGreaterThan(wrap.plaintextLength);
    } finally {
      await browser.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("Chromium unlocks the Account Master Key through a recovery code", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "dotrelay-client-"));
  try {
    const bundlePath = await buildRunner(outputDirectory);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto("https://example.com");
      await page.addScriptTag({ path: bundlePath });
      const accountKey = await evaluate<{
        readonly accountMasterKeyLength: number;
        readonly recoveryCodeCharacters: number;
        readonly codeRoundTripMatches: boolean;
        readonly accountMasterKeyMatches: boolean;
      }>(page, "dotRelayClientAccountKeyRoundTrip");
      expect(accountKey.accountMasterKeyLength).toBe(32);
      // 52 Crockford symbols in 13 groups of 4, separated by 12 dashes.
      expect(accountKey.recoveryCodeCharacters).toBe(64);
      expect(accountKey.codeRoundTripMatches).toBe(true);
      expect(accountKey.accountMasterKeyMatches).toBe(true);
    } finally {
      await browser.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
