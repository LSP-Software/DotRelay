import { expect, test } from "bun:test";
import {
  buildGettingStarted,
  type GettingStartedInput,
  gettingStartedDismissedKey,
} from "./getting-started";

const fresh = (
  overrides: Partial<GettingStartedInput> = {},
): GettingStartedInput => ({
  sessionActive: true,
  profileTrusted: false,
  cryptoAvailable: true,
  browserEnrolled: false,
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
    "team",
    "browser",
  ]);
  expect(current(fresh())).toBe("trust");
  expect(current(fresh({ profileTrusted: true, otherDeviceCount: 0 }))).toBe(
    "cli",
  );
  expect(current(fresh({ profileTrusted: true, otherDeviceCount: 1 }))).toBe(
    "team",
  );
});

test("dismissal does not hide the checklist while there is no team", () => {
  const model = buildGettingStarted(fresh({ dismissed: true }));
  expect(model.visible).toBe(true);
  expect(model.resumable).toBe(false);
});

test("an account with a team skips CLI creation and can dismiss the checklist", () => {
  const model = buildGettingStarted(fresh({ teamCount: 1 }));
  expect(model.steps.map((step) => step.id)).toEqual(["trust", "browser"]);
  expect(current(fresh({ teamCount: 1, profileTrusted: true }))).toBe(
    "browser",
  );

  const dismissed = buildGettingStarted(
    fresh({ teamCount: 1, dismissed: true }),
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
