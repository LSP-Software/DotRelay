import { expect, test } from "bun:test";
import { oauthErrorMessage } from "./oauth-error";

test("maps known GitHub return codes and hides anything else", () => {
  expect(oauthErrorMessage(undefined)).toBeNull();
  expect(oauthErrorMessage("state_mismatch")).toContain("Try again from here");
  expect(oauthErrorMessage("not a real code")).toBe(
    "GitHub sign-in didn't finish. Try again.",
  );
});
