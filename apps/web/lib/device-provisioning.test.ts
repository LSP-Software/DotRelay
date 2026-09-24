import { expect, test } from "bun:test";
import { bootstrapFailureMessage } from "./device-provisioning";

test("a signed-out bootstrap failure points at sign-in", () => {
  expect(bootstrapFailureMessage("authentication_required")).toBe(
    "Sign in before setting up this browser.",
  );
});

test("a conflicting bootstrap keeps the plain retry line", () => {
  expect(bootstrapFailureMessage("state_conflict")).toBe(
    "We couldn't set up this browser. Try again.",
  );
});

test("an unavailable server names the retry", () => {
  expect(bootstrapFailureMessage("service_unavailable")).toBe(
    "The server couldn't finish setting up this browser right now. Try again in a moment.",
  );
});

test("a rate-limited bootstrap tells the browser to wait", () => {
  expect(bootstrapFailureMessage("rate_limited")).toBe(
    "The server is limiting requests from this browser right now. Wait a moment, then try again.",
  );
});

test("a revoked device points at the Devices list", () => {
  expect(bootstrapFailureMessage("device_not_active")).toBe(
    "This browser's device is no longer active on the server. It may have been revoked; check the Devices list, then try again.",
  );
});

test("an incompatible server names browser compatibility", () => {
  for (const code of [
    "unsupported_api_version",
    "unsupported_crypto_suite",
    "unsupported_crypto_runtime",
  ] as const)
    expect(bootstrapFailureMessage(code)).toBe(
      "This server uses an API or cryptography this browser can't use. Try a current version of your browser.",
    );
});

test("an invalid bootstrap asks for a retry", () => {
  for (const code of ["invalid_request", "invalid_crypto_object"] as const)
    expect(bootstrapFailureMessage(code)).toBe(
      "The server didn't accept this browser's setup. Try again; if it keeps happening, this browser may not be compatible with the server.",
    );
});

test("an unknown or missing code falls back to a neutral retry", () => {
  for (const code of [null, "some_future_code"] as const)
    expect(bootstrapFailureMessage(code)).toBe(
      "We couldn't set up this browser. Try again; if it keeps failing, the server or your connection may be the problem.",
    );
});
