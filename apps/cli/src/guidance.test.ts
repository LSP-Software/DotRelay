import { describe, expect, test } from "bun:test";
import { guidanceFor, nextCommandFor } from "./guidance";

const origin = "https://api.dotrelay.dev";

describe("guidance", () => {
  test("a guided run promises to carry on; a script is only told what to run", () => {
    const guided = guidanceFor("authentication_required", {
      command: "pull",
      origin,
      guided: true,
    });
    expect(guided?.title).toBe("You're signed out of api.dotrelay.dev");
    expect(guided?.explain).toBe(
      "Sign in with GitHub, then dotrelay pull carries on.",
    );
    expect(guided?.offer?.fix).toEqual({ kind: "command", args: ["login"] });
    expect(guided?.offer?.resume).toBe(true);
    const scripted = guidanceFor("authentication_required", {
      command: "pull",
      origin,
    });
    expect(scripted?.explain).toBe("Sign in with GitHub.");
    expect(scripted?.next).toBe("dotrelay login");
  });

  test("login and status don't claim to carry on after signing in", () => {
    for (const command of ["login", "status"]) {
      const guidance = guidanceFor("authentication_required", {
        command,
        origin,
        guided: true,
      });
      expect(guidance?.explain).toBe("Sign in with GitHub.");
      expect(guidance?.offer?.resume).toBe(false);
    }
  });

  test("a machine with no server is offered setup against the hosted origin", () => {
    const guidance = guidanceFor("profile_not_selected", { command: "pull" });
    expect(guidance?.offer?.fix).toEqual({ kind: "setup" });
    expect(guidance?.next).toBe("dotrelay setup https://api.dotrelay.dev");
  });

  test("--no-input names a recovery path that needs no prompt", () => {
    expect(
      nextCommandFor("account_key_not_unlocked", {
        command: "pull",
        noInput: true,
      }),
    ).toBe("dotrelay device recover --recovery-code-file <path>");
    expect(
      nextCommandFor("account_key_not_unlocked", { command: "pull" }),
    ).toBe("dotrelay device recover");
  });

  test("only fixes the user can do are offered", () => {
    // A revoked device needs approval from another device; a missing key
    // share needs a teammate. Neither is offered as a one-key fix.
    expect(
      guidanceFor("device_not_active", { command: "pull" })?.offer,
    ).toBeUndefined();
    expect(
      guidanceFor("membership_not_key_provisioned", { command: "pull" })?.offer,
    ).toBeUndefined();
  });

  test("a dropped connection is retried, not repaired", () => {
    const guidance = guidanceFor("service_unavailable", {
      command: "push",
      origin,
    });
    expect(guidance?.title).toBe("Couldn't reach api.dotrelay.dev");
    expect(guidance?.offer?.fix).toEqual({ kind: "retry" });
  });

  test("publishing from a pull is offered, never from push", () => {
    expect(
      guidanceFor("project_not_linked", { command: "pull" })?.offer?.fix,
    ).toEqual({ kind: "command", args: ["init"] });
    expect(
      guidanceFor("project_not_linked", { command: "push" })?.offer,
    ).toBeUndefined();
  });

  test("codes without guidance fall back to the error's own text", () => {
    expect(guidanceFor("variable_conflict", { command: "push" })).toBeNull();
  });
});
