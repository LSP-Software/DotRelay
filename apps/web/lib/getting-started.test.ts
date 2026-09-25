import { expect, test } from "bun:test";
import {
  buildGettingStarted,
  cliInstallCommand,
  cliPackageManagerKey,
  type GettingStartedInput,
  gettingStartedDismissedKey,
  readCliPackageManager,
} from "./getting-started";

const fresh = (
  overrides: Partial<GettingStartedInput> = {},
): GettingStartedInput => ({
  sessionActive: true,
  profileTrusted: false,
  cryptoAvailable: true,
  browserEnrolled: false,
  recoveryConfigured: false,
  teamCount: 0,
  otherDeviceCount: 0,
  dismissed: false,
  ...overrides,
});

const current = (input: GettingStartedInput) =>
  buildGettingStarted(input).steps.find((step) => step.status === "current")
    ?.id;

test("a signed-out or crypto-unavailable browser does not get the checklist", () => {
  expect(buildGettingStarted(fresh({ sessionActive: false })).visible).toBe(
    false,
  );
  expect(buildGettingStarted(fresh({ cryptoAvailable: false })).visible).toBe(
    false,
  );
});

test("a new account starts at trusting the server, then the CLI, then a team", () => {
  const model = buildGettingStarted(fresh());
  expect(model.visible).toBe(true);
  expect(model.resumable).toBe(false);
  expect(model.steps.map((step) => step.id)).toEqual([
    "trust",
    "cli",
    "recovery",
    "team",
    "browser",
  ]);
  expect(current(fresh())).toBe("trust");
  expect(current(fresh({ profileTrusted: true, otherDeviceCount: 0 }))).toBe(
    "cli",
  );
  expect(current(fresh({ profileTrusted: true, otherDeviceCount: 1 }))).toBe(
    "recovery",
  );
  expect(
    current(
      fresh({
        profileTrusted: true,
        otherDeviceCount: 1,
        recoveryConfigured: true,
      }),
    ),
  ).toBe("team");
});

test("dismissal does not hide the checklist while there is no team", () => {
  const model = buildGettingStarted(fresh({ dismissed: true }));
  expect(model.visible).toBe(true);
  expect(model.resumable).toBe(false);
});

test("a team cannot hide the recovery step before a code exists", () => {
  const model = buildGettingStarted(
    fresh({
      teamCount: 1,
      profileTrusted: true,
      browserEnrolled: true,
      dismissed: true,
    }),
  );
  expect(model.visible).toBe(true);
  expect(
    current(
      fresh({ teamCount: 1, profileTrusted: true, browserEnrolled: true }),
    ),
  ).toBe("recovery");
});

test("an account with a team skips CLI creation and can dismiss the checklist", () => {
  const model = buildGettingStarted(fresh({ teamCount: 1 }));
  expect(model.steps.map((step) => step.id)).toEqual([
    "trust",
    "browser",
    "recovery",
  ]);
  expect(current(fresh({ teamCount: 1, profileTrusted: true }))).toBe(
    "browser",
  );

  const dismissed = buildGettingStarted(
    fresh({ teamCount: 1, dismissed: true, recoveryConfigured: true }),
  );
  expect(dismissed.visible).toBe(false);
  expect(dismissed.resumable).toBe(true);
  expect(dismissed.steps).toEqual([]);
});

test("the checklist leaves once the server is trusted, this browser is enrolled, and a team exists", () => {
  const model = buildGettingStarted(
    fresh({
      teamCount: 2,
      profileTrusted: true,
      browserEnrolled: true,
      recoveryConfigured: true,
      otherDeviceCount: 1,
    }),
  );
  expect(model.visible).toBe(false);
  expect(model.resumable).toBe(false);
});

test("the dismissal key is scoped to the user", () => {
  expect(gettingStartedDismissedKey("user-1")).toBe(
    "dotrelay.getting-started.dismissed:user-1",
  );
  expect(gettingStartedDismissedKey("user-1")).not.toBe(
    gettingStartedDismissedKey("user-2"),
  );
});

test("each package manager maps to its global install command", () => {
  expect(cliInstallCommand("npm")).toBe("npm install -g dotrelay@latest");
  expect(cliInstallCommand("yarn")).toBe("yarn global add dotrelay");
  expect(cliInstallCommand("pnpm")).toBe("pnpm add -g dotrelay");
  expect(cliInstallCommand("bun")).toBe("bun add -g dotrelay");
});

test("the package manager key is not user-scoped", () => {
  expect(cliPackageManagerKey).toBe("dotrelay.getting-started.package-manager");
});

test("without a browser the install preference falls back to npm", () => {
  expect(readCliPackageManager()).toBe("npm");
});
