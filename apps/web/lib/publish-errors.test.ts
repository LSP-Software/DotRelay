import { describe, expect, test } from "bun:test";
import { ProtocolTransportError } from "@dotrelay/client";
import { publishFailureMessage } from "./publish-errors";

const problem = (code: string) =>
  new ProtocolTransportError({
    type: "https://dotrelay.dev/problems/v1",
    title: "Problem",
    status: 409,
    code: code as never,
    detail: "detail",
  });

describe("publishFailureMessage", () => {
  test("a network failure says the server was unreachable", () => {
    const message = publishFailureMessage(new TypeError("Failed to fetch"));
    expect(message).toContain("Couldn't reach the server");
    expect(message).toContain("Your draft is kept.");
  });

  test("an offline browser reports the connection even for other errors", () => {
    expect(
      publishFailureMessage(problem("service_unavailable"), { online: false }),
    ).toContain("Couldn't reach the server");
  });

  test.each([
    ["authentication_required", "Sign in again in a new tab"],
    ["device_not_active", "Set up this browser again"],
    ["forbidden", "doesn't allow this change"],
    ["membership_not_key_provisioned", "share project keys"],
    ["stale_epoch", "keys changed"],
    ["archived_resource", "archived"],
    ["operation_conflict", "Use Refresh in the editor"],
    ["staging_expired", "expired"],
    ["payload_too_large", "smaller parts"],
    ["rate_limited", "limiting requests"],
    ["service_unavailable", "unavailable right now"],
    ["invalid_crypto_object", "refused this publication as invalid"],
  ])("%s gets a specific message", (code, fragment) => {
    const message = publishFailureMessage(problem(code));
    expect(message).toContain(fragment);
    expect(message).toContain("Your draft is kept.");
  });

  test("no message tells the user to refresh the page", () => {
    const codes = [
      "authentication_required",
      "device_not_active",
      "forbidden",
      "stale_epoch",
      "operation_conflict",
      "service_unavailable",
      "something_new",
    ];
    for (const code of codes)
      expect(publishFailureMessage(problem(code))).not.toMatch(
        /refresh (the|this) page|Refresh and try again/i,
      );
    expect(publishFailureMessage(new Error("boom"))).toContain("Try again.");
  });
});
