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
  readonly dotRelayClientPasswordWorkerRoundTrip: () => Promise<{
    readonly matches: boolean;
    readonly usedWorker: boolean;
    readonly ticksDelta: number;
  }>;
  readonly dotRelayClientPasskeyPrf: () => Promise<{
    readonly supported: boolean;
    readonly extract32Length: number;
    readonly extract64Rejected: boolean;
    readonly extract16Rejected: boolean;
    readonly missingRejected: boolean;
    readonly emptyResultsRejected: boolean;
    readonly enabledWithoutResultRejected: boolean;
    readonly assertion32Length: number;
    readonly assertionInputBound: boolean;
    readonly assertionCarriesPrfEvalInput: boolean;
    readonly cancelledCode: string | null;
    readonly noMatchingCode: string | null;
    readonly nullCredentialCode: string | null;
    readonly createFromCreateOutput: boolean;
    readonly createViaConfirmation: boolean;
    readonly createDiscardedCode: string | null;
    readonly createDiscardedDeleted: number;
    readonly createDisabledCode: string | null;
    readonly createDisabledAssertions: number;
    readonly createDisabledDeleted: number;
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

// Build the self-contained Argon2 worker IIFE separately from the client bundle.
// The test injects its source through __DOTRELAY_ARGON2_WORKER_SOURCE__ so the
// round trip's KDF runs in a real Chromium Worker off the main thread.
const buildWorker = async (outputDirectory: string) => {
  const build = await Bun.build({
    entrypoints: ["packages/client/src/account/argon2-worker.ts"],
    format: "iife",
    outdir: outputDirectory,
    target: "browser",
  });
  expect(build.success).toBe(true);
  return join(outputDirectory, "argon2-worker.js");
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

test("Chromium drives the WebAuthn prf path through the platform interface (simulation)", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "dotrelay-client-"));
  try {
    const bundlePath = await buildRunner(outputDirectory);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto("https://example.com");
      await page.addScriptTag({ path: bundlePath });
      // This test simulates the platform interface: Playwright cannot
      // emulate the PRF extension, so the runner drives
      // runPasskeyAssertion/createPasskeyWithPrf against a faithful in-page
      // fake of the real PublicKeyCredential interface. A real passkey
      // hardware test is recorded as outstanding for this campaign.
      const prf = await evaluate<{
        readonly supported: boolean;
        readonly extract32Length: number;
        readonly extract64Rejected: boolean;
        readonly extract16Rejected: boolean;
        readonly missingRejected: boolean;
        readonly emptyResultsRejected: boolean;
        readonly enabledWithoutResultRejected: boolean;
        readonly assertion32Length: number;
        readonly assertionInputBound: boolean;
        readonly assertionCarriesPrfEvalInput: boolean;
        readonly cancelledCode: string | null;
        readonly noMatchingCode: string | null;
        readonly nullCredentialCode: string | null;
        readonly createFromCreateOutput: boolean;
        readonly createViaConfirmation: boolean;
        readonly createDiscardedCode: string | null;
        readonly createDiscardedDeleted: number;
        readonly createDisabledCode: string | null;
        readonly createDisabledAssertions: number;
        readonly createDisabledDeleted: number;
      }>(page, "dotRelayClientPasskeyPrf");
      // Chromium exposes the PublicKeyCredential surface, so the PRF path
      // is detected as available.
      expect(prf.supported).toBe(true);
      // A 32-byte PRF extension output is extracted at its spec length ...
      expect(prf.extract32Length).toBe(32);
      // ... and any other length, a missing extension, or a platform that
      // reports the PRF unsupported is rejected.
      expect(prf.extract64Rejected).toBe(true);
      expect(prf.extract16Rejected).toBe(true);
      expect(prf.missingRejected).toBe(true);
      expect(prf.emptyResultsRejected).toBe(true);
      expect(prf.enabledWithoutResultRejected).toBe(true);
      // An assertion requesting the Level 3 PRF extension input
      // ({ prf: { eval: { first } } }) returns the credential-bound 32-byte
      // output, and different PRF inputs yield different outputs.
      expect(prf.assertion32Length).toBe(32);
      expect(prf.assertionInputBound).toBe(true);
      expect(prf.assertionCarriesPrfEvalInput).toBe(true);
      // Platform failures classify into distinct, honest error codes.
      expect(prf.cancelledCode).toBe("cancelled");
      expect(prf.noMatchingCode).toBe("no-matching-credential");
      expect(prf.nullCredentialCode).toBe("no-matching-credential");
      // Creation uses the creation-time output when present ...
      expect(prf.createFromCreateOutput).toBe(true);
      // ... otherwise confirms through a real assertion ...
      expect(prf.createViaConfirmation).toBe(true);
      // ... and discards a credential that can deliver no PRF output.
      expect(prf.createDiscardedCode).toBe("unsupported");
      expect(prf.createDiscardedDeleted).toBe(1);
      expect(prf.createDisabledCode).toBe("unsupported");
      expect(prf.createDisabledAssertions).toBe(0);
      expect(prf.createDisabledDeleted).toBe(1);
    } finally {
      await browser.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("Chromium runs the password KDF in a Worker off the main thread", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "dotrelay-client-"));
  try {
    const bundlePath = await buildRunner(outputDirectory);
    const workerPath = await buildWorker(outputDirectory);
    const workerSource = await Bun.file(workerPath).text();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto("https://example.com");
      await page.addScriptTag({ path: bundlePath });
      // Hand the separately-built worker IIFE to the runtime so the round
      // trip's Argon2id executes in a Worker rather than on the main thread.
      await page.evaluate((source) => {
        (
          globalThis as { __DOTRELAY_ARGON2_WORKER_SOURCE__?: string }
        ).__DOTRELAY_ARGON2_WORKER_SOURCE__ = source;
      }, workerSource);
      // Main-thread responsiveness probe: a fast interval must keep firing while
      // the KDF window runs off-thread. If the KDF blocked the main thread, the
      // counter would not advance during the round trip.
      const tickTimer = await page.evaluate(() => {
        (globalThis as { __dotrelayTicks?: number }).__dotrelayTicks = 0;
        return setInterval(() => {
          const g = globalThis as { __dotrelayTicks?: number };
          g.__dotrelayTicks = (g.__dotrelayTicks ?? 0) + 1;
        }, 5);
      });
      try {
        const roundTrip = await evaluate<{
          readonly matches: boolean;
          readonly usedWorker: boolean;
          readonly ticksDelta: number;
        }>(page, "dotRelayClientPasswordWorkerRoundTrip");
        // The KDF actually ran through the worker branch ...
        expect(roundTrip.usedWorker).toBe(true);
        // ... and the password wrapper round-tripped the AMK correctly.
        expect(roundTrip.matches).toBe(true);
        // The event loop stayed responsive through the off-thread KDF window.
        expect(roundTrip.ticksDelta).toBeGreaterThan(0);
      } finally {
        await page.evaluate((timer) => {
          clearInterval(timer);
        }, tickTimer);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
