import { describe, expect, test } from "bun:test";
import {
  decideLaneDisclosure,
  decideTeamAction,
  type MembershipAccess,
} from "./administration";

const membership = (
  role: MembershipAccess["role"],
  lifecycle: MembershipAccess["lifecycle"] = "ACTIVE",
): MembershipAccess => ({ role, lifecycle });

describe("administration policy", () => {
  test("enforces every role and Membership lifecycle edge", () => {
    const actions = [
      "VIEW",
      "INVITE_MEMBER",
      "MANAGE_MEMBER",
      "MANAGE_ADMIN",
      "MANAGE_OWNER",
      "ADMINISTER_PROJECT",
      "ADMINISTER_ENVIRONMENT",
    ] as const;

    expect(
      actions.map((action) => decideTeamAction(membership("OWNER"), action)),
    ).toEqual(actions.map(() => ({ allowed: true })));
    expect(
      actions.map((action) => decideTeamAction(membership("ADMIN"), action)),
    ).toEqual([
      { allowed: true },
      { allowed: true },
      { allowed: true },
      { allowed: false, reason: "insufficient_role" },
      { allowed: false, reason: "insufficient_role" },
      { allowed: true },
      { allowed: true },
    ]);
    expect(
      actions.map((action) => decideTeamAction(membership("MEMBER"), action)),
    ).toEqual([
      { allowed: true },
      ...actions.slice(1).map(() => ({
        allowed: false as const,
        reason: "insufficient_role" as const,
      })),
    ]);

    for (const lifecycle of ["PENDING_KEY_GRANT", "REMOVED"] as const) {
      for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) {
        for (const action of actions) {
          expect(decideTeamAction(membership(role, lifecycle), action)).toEqual(
            { allowed: false, reason: "membership_not_active" },
          );
        }
      }
    }
    for (const action of actions) {
      expect(decideTeamAction(null, action)).toEqual({
        allowed: false,
        reason: "membership_missing",
      });
    }
  });

  test("does not derive DotRelay access from GitHub repository admission", () => {
    expect(
      decideTeamAction(null, "VIEW", { githubRepositoryAdmission: true }),
    ).toEqual({ allowed: false, reason: "membership_missing" });
  });

  test("never discloses another User's User-defined Value", () => {
    for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) {
      const actor = membership(role);
      expect(
        decideLaneDisclosure(
          actor,
          "ACTIVE",
          {
            scope: "USER_DEFINED_VALUE",
            ownerUserId: "another-user",
          },
          "actor-user",
        ),
      ).toEqual({ allowed: false, reason: "user_value_owned_by_another_user" });
      expect(
        decideLaneDisclosure(
          actor,
          "ACTIVE",
          {
            scope: "SHARED_VALUE",
          },
          "actor-user",
        ),
      ).toEqual({ allowed: true });
      expect(
        decideLaneDisclosure(
          actor,
          "ACTIVE",
          {
            scope: "USER_DEFINED_VALUE",
            ownerUserId: "actor-user",
          },
          "actor-user",
        ),
      ).toEqual({ allowed: true });
      expect(
        decideLaneDisclosure(
          actor,
          "ARCHIVED",
          {
            scope: "SHARED_VALUE",
          },
          "actor-user",
        ),
      ).toEqual({ allowed: false, reason: "resource_not_active" });
    }
    expect(
      decideLaneDisclosure(
        membership("MEMBER", "PENDING_KEY_GRANT"),
        "ACTIVE",
        {
          scope: "SHARED_VALUE",
        },
        "actor-user",
      ),
    ).toEqual({ allowed: false, reason: "membership_not_active" });
  });
});
