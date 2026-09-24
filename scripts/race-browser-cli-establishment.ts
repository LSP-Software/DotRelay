import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import type { PrismaClient } from "../packages/database/src/index";

type CliRun = Readonly<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}>;

type ApprovedRun = CliRun & { readonly approvals: number };

export type BrowserCliRaceDeps = Readonly<{
  readonly database: PrismaClient;
  readonly profileOrigin: string;
  readonly serverProfileId: string;
  readonly isolatedDirectory: string;
  readonly sessionCookieFor: (
    token: string,
  ) => Promise<Readonly<{ readonly header: string; readonly value: string }>>;
  readonly runWithDeviceApproval: (
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    cwd: string,
    sessionCookie: string,
  ) => Promise<ApprovedRun>;
  readonly runBinary: (
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    cwd: string,
  ) => Promise<CliRun>;
  readonly writeRecoveryCodeFile: (
    directory: string,
    code: string,
    name: string,
  ) => Promise<string>;
  readonly parseJsonLines: (text: string) => Record<string, unknown>[];
  readonly requireString: (value: unknown, label: string) => string;
}>;

const callPage = async (
  page: Page,
  method: string,
  argument?: unknown,
): Promise<unknown> =>
  page.evaluate(
    async (request: {
      readonly method: string;
      readonly argument?: unknown;
    }) => {
      const host: unknown = globalThis;
      if (typeof host !== "object" || host === null)
        throw new Error("browser page has no global object");
      const record = host as Record<string, unknown>;
      const fn = record[request.method];
      if (typeof fn !== "function")
        throw new Error(`browser bundle is missing ${request.method}`);
      return fn.call(globalThis, request.argument);
    },
    argument === undefined ? { method } : { method, argument },
  );

// A Chromium page and the packaged CLI both observe zero wrappers for one
// new account, then publish a first Account Master Key at the same time.
// Exactly one wrapper remains. The loser discards its candidate and can
// still open the winner. Recovery codes are written only to a mode-600 file
// the CLI already knows how to read; they are not printed.
export const raceBrowserAndCliEstablishment = async (
  deps: BrowserCliRaceDeps,
): Promise<void> => {
  const authUserId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const sessionToken = Buffer.from(
    crypto.getRandomValues(new Uint8Array(48)),
  ).toString("base64url");
  const session = await deps.sessionCookieFor(sessionToken);
  await deps.database.authUser.create({
    data: {
      id: authUserId,
      name: "Browser Race Operator",
      email: `browser-race-${authUserId}@example.invalid`,
      emailVerified: true,
    },
  });
  await deps.database.authSession.create({
    data: {
      id: crypto.randomUUID(),
      token: sessionToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      userId: authUserId,
    },
  });
  await deps.database.authAccount.create({
    data: {
      id: crypto.randomUUID(),
      accountId: `browser-race-${userId}`,
      providerId: "github",
      userId: authUserId,
      accessToken: "browser-race-token",
      scope: "user:email",
      issuer: "",
    },
  });
  await deps.database.user.create({
    data: {
      id: userId,
      serverProfileId: deps.serverProfileId,
      authSubject: authUserId,
      githubSubject: `browser-race-${userId}`,
    },
  });

  const cliHome = join(deps.isolatedDirectory, "browser-race-cli");
  const cliRepo = join(deps.isolatedDirectory, "browser-race-repo");
  const cliEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: cliHome,
    DOTRELAY_CONFIG_DIR: join(cliHome, "cli"),
  };
  await mkdir(join(cliHome, "cli", "credentials"), { recursive: true });
  await mkdir(cliRepo, { recursive: true });
  const enrolled = await deps.runWithDeviceApproval(
    [
      "setup",
      deps.profileOrigin,
      "--accept-profile",
      deps.serverProfileId,
      "--no-input",
      "--json",
    ],
    cliEnvironment,
    cliRepo,
    session.header,
  );
  if (enrolled.exitCode !== 0 || enrolled.approvals !== 1) {
    const failure = deps.parseJsonLines(enrolled.stderr).at(-1);
    const code = typeof failure?.code === "string" ? failure.code : "none";
    const detail = typeof failure?.detail === "string" ? failure.detail : "";
    throw new Error(
      `browser-race CLI enrollment failed: exit=${enrolled.exitCode} approvals=${enrolled.approvals} code=${code} detail=${detail}`,
    );
  }
  const enrolledResult = deps.parseJsonLines(enrolled.stdout).at(-1) ?? {};
  const profileName = deps.requireString(
    enrolledResult.profile,
    "browser-race profile",
  );
  const profileFlag = ["--profile", profileName] as const;

  const bundleDirectory = await mkdtemp(
    join(tmpdir(), "dotrelay-browser-race-"),
  );
  const build = await Bun.build({
    entrypoints: ["scripts/browser-establishment-runner.ts"],
    format: "iife",
    outdir: bundleDirectory,
    target: "browser",
  });
  if (!build.success)
    throw new Error("browser establishment bundle failed to build");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const origin = new URL(deps.profileOrigin);
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: session.value,
        url: deps.profileOrigin,
        httpOnly: true,
        secure: origin.protocol === "https:",
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const loaded = await page.goto(`${deps.profileOrigin}/api/v1/capabilities`);
    if (!loaded?.ok())
      throw new Error(
        `browser could not open the API origin: ${loaded?.status() ?? "no response"}`,
      );
    await page.addScriptTag({
      path: join(bundleDirectory, "browser-establishment-runner.js"),
    });
    const preparedDeviceId = readDeviceId(
      await callPage(page, "dotRelayPrepareBrowserDevice", {
        origin: deps.profileOrigin,
        serverProfileId: deps.serverProfileId,
        userId,
      }),
    );
    const browserDevice = await deps.database.device.findFirst({
      where: { id: preparedDeviceId, userId },
    });
    if (browserDevice?.lifecycle !== "ACTIVE")
      throw new Error("the API did not activate the browser device");

    const [browserRace, cliRace] = await Promise.all([
      callPage(page, "dotRelayEstablishFromBrowser").then(readRaceResult),
      deps.runBinary(
        ["device", "setup", ...profileFlag, "--no-input", "--json"],
        cliEnvironment,
        cliRepo,
      ),
    ]);
    const wrappers = await deps.database.accountKeyWrapperObject.findMany({
      where: { userId, wrapperType: "RECOVERY_CODE", retiredAt: null },
    });
    if (wrappers.length !== 1)
      throw new Error(
        `browser and CLI establishment kept ${wrappers.length} recovery wrappers`,
      );
    const winnerWrapperId = Buffer.from(wrappers[0]?.wrapperId ?? []).toString(
      "hex",
    );
    if (browserRace.outcome === "won") {
      if (browserRace.wrapperId !== winnerWrapperId)
        throw new Error(
          "the browser's wrapper is not the single active recovery wrapper",
        );
      if (cliRace.exitCode !== 4)
        throw new Error(
          `CLI did not refuse the browser's Account Master Key: exit=${cliRace.exitCode}`,
        );
      if (
        deps.parseJsonLines(cliRace.stderr).at(-1)?.code !==
        "account_key_already_exists"
      )
        throw new Error("CLI refusal was not account_key_already_exists");
      if (cliRace.stdout.includes("recoveryCode"))
        throw new Error("the losing CLI printed a recovery code");
      const recovered = await deps.runBinary(
        [
          "device",
          "recover",
          ...profileFlag,
          "--recovery-code-file",
          await deps.writeRecoveryCodeFile(
            deps.isolatedDirectory,
            browserRace.recoveryCode,
            "browser-race-winner",
          ),
          "--no-input",
          "--json",
        ],
        cliEnvironment,
        cliRepo,
      );
      if (recovered.exitCode !== 0)
        throw new Error(
          `CLI could not recover the browser's Account Master Key: exit=${recovered.exitCode}`,
        );
      if (deps.parseJsonLines(recovered.stdout).at(-1)?.via !== "recovery-code")
        throw new Error("CLI recovery did not use the recovery code");
      const unlockedLength = readUnlockLength(
        await callPage(
          page,
          "dotRelayUnlockWinningRecoveryCode",
          browserRace.recoveryCode,
        ),
      );
      if (unlockedLength !== 32)
        throw new Error(
          "the browser did not open a 32-byte Account Master Key from the recovery code",
        );
      console.log(
        "→ browser won first establishment; the CLI discarded its candidate and recovered the browser's key",
      );
      return;
    }
    if (cliRace.exitCode !== 0)
      throw new Error(
        `both browser and CLI lost first establishment: cli exit=${cliRace.exitCode}`,
      );
    const cliResult = deps.parseJsonLines(cliRace.stdout).at(-1) ?? {};
    const cliWrapperId = deps.requireString(
      cliResult.wrapperId,
      "CLI recovery wrapper",
    );
    if (cliWrapperId !== winnerWrapperId)
      throw new Error(
        "the CLI wrapper is not the single active recovery wrapper",
      );
    const recoveryCode = deps.requireString(
      cliResult.recoveryCode,
      "CLI recovery code",
    );
    const unlockedLength = readUnlockLength(
      await callPage(page, "dotRelayUnlockWinningRecoveryCode", recoveryCode),
    );
    if (unlockedLength !== 32)
      throw new Error(
        "the browser did not open a 32-byte Account Master Key from the CLI recovery code",
      );
    console.log(
      "→ CLI won first establishment; the browser discarded its candidate and opened the CLI key",
    );
  } finally {
    await browser.close();
    await rm(bundleDirectory, { recursive: true, force: true });
  }
};

const readDeviceId = (value: unknown): string => {
  if (typeof value !== "object" || value === null || !("deviceId" in value))
    throw new Error("browser device bootstrap returned no device");
  if (typeof value.deviceId !== "string" || value.deviceId.length === 0)
    throw new Error("browser device bootstrap returned no device");
  return value.deviceId;
};

const readRaceResult = (
  value: unknown,
):
  | {
      readonly outcome: "won";
      readonly recoveryCode: string;
      readonly wrapperId: string;
    }
  | { readonly outcome: "lost" } => {
  if (typeof value !== "object" || value === null || !("outcome" in value))
    throw new Error("browser establishment returned no outcome");
  if (value.outcome === "lost") return { outcome: "lost" };
  if (
    value.outcome !== "won" ||
    !("recoveryCode" in value) ||
    typeof value.recoveryCode !== "string" ||
    !("wrapperId" in value) ||
    typeof value.wrapperId !== "string"
  )
    throw new Error("browser establishment returned no outcome");
  return {
    outcome: "won",
    recoveryCode: value.recoveryCode,
    wrapperId: value.wrapperId,
  };
};

const readUnlockLength = (value: unknown): number => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("accountMasterKeyLength" in value) ||
    typeof value.accountMasterKeyLength !== "number"
  )
    throw new Error("browser unlock returned no key length");
  return value.accountMasterKeyLength;
};
