import { expect, test } from "bun:test";
import { AccountKeyRequestError } from "./account-keys";
import { recoveryErrorMessage } from "./account-recovery";

test("a server rejection shows the operation's fallback, not the transport text", () => {
  expect(
    recoveryErrorMessage(
      new AccountKeyRequestError(
        "authentication_required",
        "The server rejected the request.",
      ),
      "The password wasn't added. Try again.",
    ),
  ).toBe("The password wasn't added. Try again.");
});

test("a failed fetch shows the operation's fallback, not the browser's text", () => {
  expect(
    recoveryErrorMessage(
      new TypeError("Failed to fetch"),
      "The transfer wasn't sent. Try again.",
    ),
  ).toBe("The transfer wasn't sent. Try again.");
});

test("a human-authored error message passes through unchanged", () => {
  expect(
    recoveryErrorMessage(
      new Error(
        "We couldn't unlock your account with that. Check the input and try again.",
      ),
      "fallback",
    ),
  ).toBe(
    "We couldn't unlock your account with that. Check the input and try again.",
  );
});

test("a non-Error throw shows the fallback", () => {
  expect(
    recoveryErrorMessage("boom", "The passkey wasn't added. Try again."),
  ).toBe("The passkey wasn't added. Try again.");
});
