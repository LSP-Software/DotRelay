import type {
  MembershipLifecycle,
  MembershipRole,
  ResourceLifecycle,
} from "./generated/prisma/client";

export type MembershipAccess = Readonly<{
  readonly role: MembershipRole;
  readonly lifecycle: MembershipLifecycle;
}>;

export type TeamAction =
  | "VIEW"
  | "INVITE_MEMBER"
  | "MANAGE_MEMBER"
  | "MANAGE_ADMIN"
  | "MANAGE_OWNER"
  | "ADMINISTER_PROJECT"
  | "ADMINISTER_ENVIRONMENT";

export type PolicyDenial =
  | "membership_missing"
  | "membership_not_active"
  | "insufficient_role"
  | "resource_not_active"
  | "user_value_owned_by_another_user";

export type PolicyDecision =
  | Readonly<{ readonly allowed: true }>
  | Readonly<{ readonly allowed: false; readonly reason: PolicyDenial }>;

const allowed = Object.freeze({ allowed: true }) as PolicyDecision;
const denied = (reason: PolicyDenial): PolicyDecision => ({
  allowed: false,
  reason,
});

const roleActions: Readonly<Record<MembershipRole, ReadonlySet<TeamAction>>> = {
  OWNER: new Set<TeamAction>([
    "VIEW",
    "INVITE_MEMBER",
    "MANAGE_MEMBER",
    "MANAGE_ADMIN",
    "MANAGE_OWNER",
    "ADMINISTER_PROJECT",
    "ADMINISTER_ENVIRONMENT",
  ]),
  ADMIN: new Set<TeamAction>([
    "VIEW",
    "INVITE_MEMBER",
    "MANAGE_MEMBER",
    "ADMINISTER_PROJECT",
    "ADMINISTER_ENVIRONMENT",
  ]),
  MEMBER: new Set<TeamAction>(["VIEW"]),
};

/**
 * GitHub repository admission is deliberately accepted as context and then
 * excluded from the decision. GitHub identifies invitations and Projects; it
 * never grants DotRelay authority.
 */
export const decideTeamAction = (
  membership: MembershipAccess | null,
  action: TeamAction,
  _externalContext: Readonly<{
    readonly githubRepositoryAdmission: boolean;
  }> = {
    githubRepositoryAdmission: false,
  },
): PolicyDecision => {
  if (!membership) return denied("membership_missing");
  if (membership.lifecycle !== "ACTIVE") return denied("membership_not_active");
  return roleActions[membership.role].has(action)
    ? allowed
    : denied("insufficient_role");
};

export type DisclosableLane = Readonly<{
  readonly scope:
    | "ENVIRONMENT_DEFINITION"
    | "VARIABLE_DEFINITION"
    | "SHARED_VALUE"
    | "USER_DEFINED_VALUE";
  readonly ownerUserId?: string | null;
}>;

export const decideLaneDisclosure = (
  membership: MembershipAccess | null,
  resourceLifecycle: ResourceLifecycle,
  lane: DisclosableLane,
  actorUserId: string,
): PolicyDecision => {
  const membershipDecision = decideTeamAction(membership, "VIEW");
  if (!membershipDecision.allowed) return membershipDecision;
  if (resourceLifecycle !== "ACTIVE") return denied("resource_not_active");
  if (lane.scope === "USER_DEFINED_VALUE" && lane.ownerUserId !== actorUserId)
    return denied("user_value_owned_by_another_user");
  return allowed;
};
