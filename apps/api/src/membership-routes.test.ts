import { describe, expect, test } from "bun:test";
import type { DotRelayAuth } from "./auth";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const TEAM_A = "11111111-1111-4111-8111-111111111111";
const TEAM_B = "22222222-2222-4222-8222-222222222222";
const TEAM_ARCHIVED = "32222222-3222-4222-8222-322232223222";
const USER_OWNER = "33333333-3333-4333-8333-333333333333";
const USER_MEMBER = "44444444-4444-4444-8444-444444444444";
const USER_PENDING = "55555555-5555-4555-8555-555555555555";
const USER_INVITEE = "66666666-6666-4666-8666-666666666666";
const USER_ADMIN = "76666666-7666-4766-8766-767676767676";
const USER_OWNER_TWO = "87777777-8777-4877-8877-878787878787";
const USER_OLD = "77777777-7777-4777-8777-777777777777";
const DEVICE_OWNER = "88888888-8888-4888-8888-888888888888";
const INV_ACTIVE = "99999999-9999-4999-8999-999999999999";
const INV_EXPIRED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INV_OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INV_ACCEPTED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INV_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DAY = 24 * 60 * 60 * 1000;
// Frozen at module load: both the dataset and the expected values derive from
// the same instant, so only the route's own "now" moves between them.
const NOW = Date.now();
const t = (offsetDays: number) => new Date(NOW + offsetDays * DAY);

type MembershipRole = "OWNER" | "ADMIN" | "MEMBER";
type MembershipLifecycle = "ACTIVE" | "PENDING_KEY_GRANT" | "REMOVED";

type StubMembership = {
  id: string;
  teamId: string;
  userId: string;
  role: MembershipRole;
  lifecycle: MembershipLifecycle;
  createdAt: Date;
  activatedAt: Date | null;
  removedAt: Date | null;
  invitationId: string | null;
};

type StubInvitation = {
  id: string;
  teamId: string;
  providerSubject: string;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
};

const profile = loadServerProfileConfig({});

const users = [
  {
    id: USER_OWNER,
    serverProfileId: profile.id,
    authSubject: "auth-owner",
    githubSubject: "1001",
  },
  {
    id: USER_MEMBER,
    serverProfileId: profile.id,
    authSubject: "auth-member",
    githubSubject: "2002",
  },
  {
    id: USER_PENDING,
    serverProfileId: profile.id,
    authSubject: "auth-pending",
    githubSubject: "3003",
  },
  {
    id: USER_INVITEE,
    serverProfileId: profile.id,
    authSubject: "auth-invitee",
    githubSubject: "583231",
  },
  {
    id: USER_ADMIN,
    serverProfileId: profile.id,
    authSubject: "auth-admin",
    githubSubject: "6006",
  },
  {
    id: USER_OWNER_TWO,
    serverProfileId: profile.id,
    authSubject: "auth-owner-two",
    githubSubject: "7007",
  },
  {
    id: USER_OLD,
    serverProfileId: profile.id,
    authSubject: "auth-old",
    githubSubject: "4004",
  },
];
const authAccounts = [
  { userId: "auth-owner", providerId: "github", accountId: "1001" },
  { userId: "auth-member", providerId: "github", accountId: "2002" },
  { userId: "auth-pending", providerId: "github", accountId: "3003" },
  { userId: "auth-invitee", providerId: "github", accountId: "583231" },
  { userId: "auth-old", providerId: "github", accountId: "4004" },
  { userId: "auth-admin", providerId: "github", accountId: "6006" },
  { userId: "auth-owner-two", providerId: "github", accountId: "7007" },
];

const authUsers = [
  { id: "auth-owner", name: "Owner Person", image: null },
  { id: "auth-member", name: "Member Person", image: "https://a/1.png" },
  { id: "auth-pending", name: null, image: null },
  { id: "auth-invitee", name: "Invitee Person", image: null },
  { id: "auth-admin", name: "Admin Person", image: null },
  { id: "auth-owner-two", name: "Second Owner", image: null },
];

const teams = [
  {
    id: TEAM_A,
    serverProfileId: profile.id,
    lifecycle: "ACTIVE",
    name: "Alpha",
  },
  {
    id: TEAM_B,
    serverProfileId: profile.id,
    lifecycle: "ACTIVE",
    name: "Beta",
  },
  {
    id: TEAM_ARCHIVED,
    serverProfileId: profile.id,
    lifecycle: "ARCHIVED",
    name: "Old",
  },
];

const DEVICE_MEMBER = "a9999999-a999-4a99-8a99-a999a999a999";
const DEVICE_ADMIN = "b9999999-b999-4b99-8b99-b9b9b9b9b9b9";
const DEVICE_OWNER_TWO = "c9999999-c999-4c99-8c99-c9c9c9c9c9c9";
const MEMBER_M1 = "8b5a507c-0567-412b-9634-f778f4cb00bb";
const MEMBER_M2 = "dd4bf153-c982-4ead-b856-c22c9de5f4f7";
const MEMBER_M3 = "3e11ba80-862f-40f3-aae0-51d22bb79380";
const MEMBER_M4 = "16f3a76c-cca1-4845-9616-3416f9fe9bd3";
const MEMBER_M5 = "60b2306b-4076-40d1-a827-8dc69937fde1";
const MEMBER_M6 = "fa336ad6-0f87-4c8a-a261-a7504656503c";
const MEMBER_M7 = "6f186f71-26dd-4b03-bc7b-e386fc63df04";
const MEMBER_M8 = "9be61968-a622-4aa0-8a6b-01ed5d2dad43";
const devices = [
  { id: DEVICE_OWNER, userId: USER_OWNER, lifecycle: "ACTIVE" },
  { id: DEVICE_MEMBER, userId: USER_MEMBER, lifecycle: "ACTIVE" },
  { id: DEVICE_ADMIN, userId: USER_ADMIN, lifecycle: "ACTIVE" },
  { id: DEVICE_OWNER_TWO, userId: USER_OWNER_TWO, lifecycle: "ACTIVE" },
];

const memberships: StubMembership[] = [
  {
    id: MEMBER_M1,
    teamId: TEAM_A,
    userId: USER_OWNER,
    role: "OWNER",
    lifecycle: "ACTIVE",
    createdAt: t(-30),
    activatedAt: t(-30),
    removedAt: null,
    invitationId: null,
  },
  {
    id: MEMBER_M2,
    teamId: TEAM_A,
    userId: USER_MEMBER,
    role: "MEMBER",
    lifecycle: "ACTIVE",
    createdAt: t(-20),
    activatedAt: t(-20),
    removedAt: null,
    invitationId: null,
  },
  {
    id: MEMBER_M3,
    teamId: TEAM_A,
    userId: USER_PENDING,
    role: "MEMBER",
    lifecycle: "PENDING_KEY_GRANT",
    createdAt: t(-2),
    activatedAt: null,
    removedAt: null,
    invitationId: INV_ACCEPTED,
  },
  {
    id: MEMBER_M4,
    teamId: TEAM_A,
    userId: USER_OLD,
    role: "MEMBER",
    lifecycle: "REMOVED",
    createdAt: t(-40),
    activatedAt: t(-40),
    removedAt: t(-10),
    invitationId: null,
  },
  {
    id: MEMBER_M5,
    teamId: TEAM_B,
    userId: USER_OWNER,
    role: "OWNER",
    lifecycle: "ACTIVE",
    createdAt: t(-15),
    activatedAt: t(-15),
    removedAt: null,
    invitationId: null,
  },
  {
    id: MEMBER_M6,
    teamId: TEAM_B,
    userId: USER_INVITEE,
    role: "MEMBER",
    lifecycle: "PENDING_KEY_GRANT",
    createdAt: t(-1),
    activatedAt: null,
    removedAt: null,
    invitationId: INV_B,
  },
  {
    id: MEMBER_M7,
    teamId: TEAM_A,
    userId: USER_ADMIN,
    role: "ADMIN",
    lifecycle: "ACTIVE",
    createdAt: t(-18),
    activatedAt: t(-18),
    removedAt: null,
    invitationId: null,
  },
  {
    id: MEMBER_M8,
    teamId: TEAM_A,
    userId: USER_OWNER_TWO,
    role: "OWNER",
    lifecycle: "ACTIVE",
    createdAt: t(-12),
    activatedAt: t(-12),
    removedAt: null,
    invitationId: null,
  },
];

const invitations: StubInvitation[] = [
  {
    id: INV_ACTIVE,
    teamId: TEAM_A,
    providerSubject: "583231",
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: t(-1),
    expiresAt: t(6),
  },
  {
    id: INV_EXPIRED,
    teamId: TEAM_A,
    providerSubject: "583231",
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: t(-9),
    expiresAt: t(-2),
  },
  {
    id: INV_OTHER,
    teamId: TEAM_B,
    providerSubject: "9999",
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: t(-1),
    expiresAt: t(6),
  },
  {
    id: INV_ACCEPTED,
    teamId: TEAM_A,
    providerSubject: "3003",
    acceptedByUserId: USER_PENDING,
    acceptedAt: t(-2),
    createdAt: t(-9),
    expiresAt: t(-2),
  },
  {
    id: INV_B,
    teamId: TEAM_B,
    providerSubject: "583231",
    acceptedByUserId: USER_INVITEE,
    acceptedAt: t(-1),
    createdAt: t(-8),
    expiresAt: t(-1),
  },
];

const sessions = new Map<string, string>([
  ["owner-token", "auth-owner"],
  ["member-token", "auth-member"],
  ["pending-token", "auth-pending"],
  ["invitee-token", "auth-invitee"],
  ["admin-token", "auth-admin"],
  ["owner-two-token", "auth-owner-two"],
]);

const createAuthStub = (): DotRelayAuth =>
  ({
    api: {
      getSession: async ({
        headers,
      }: {
        headers: Headers;
      }): Promise<null | { user: { id: string } }> => {
        const authorization = headers.get("Authorization");
        if (!authorization?.startsWith("Bearer ")) return null;
        const userId = sessions.get(authorization.slice("Bearer ".length));
        return userId === undefined ? null : { user: { id: userId } };
      },
    },
    $context: Promise.resolve({
      options: {},
      secretConfig: { secret: "test-secret" },
      internalAdapter: {
        findAccounts: async (userId: string) =>
          authAccounts
            .filter((account) => account.userId === userId)
            .map((account) => ({
              providerId: account.providerId,
              accessToken: "delegated-token",
            })),
      },
    }),
  }) as unknown as DotRelayAuth;

const createDatabaseStub = () => {
  // Each stub clones the invitation rows: acceptance mutates them, and one
  // test's acceptance must never leak into another test's dataset.
  const localInvitations = invitations.map((invitation) => ({ ...invitation }));
  const localMemberships = memberships.map((membership) => ({ ...membership }));
  const operations = new Map<
    string,
    {
      id: string;
      actorUserId: string;
      actorDeviceId: string | null;
      kind: string;
      commandDigest: Uint8Array;
      status: "STAGED" | "COMMITTED";
    }
  >();
  const auditEvents: Array<Record<string, unknown>> = [];
  const createdMemberships: StubMembership[] = [];
  const createdInvitations: StubInvitation[] = [];

  const database = {
    $transaction: async (
      callback: (transaction: unknown) => Promise<unknown>,
    ) => callback(database),
    $executeRaw: async () => 0,
    authAccount: {
      findFirst: async ({
        where,
      }: {
        where: { userId: string; providerId: string };
      }) =>
        authAccounts.find(
          (account) =>
            account.userId === where.userId &&
            account.providerId === where.providerId,
        ) ?? null,
    },
    authUser: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        authUsers.filter((user) => where.id.in.includes(user.id)),
    },
    user: {
      upsert: async ({
        where,
      }: {
        where: {
          serverProfileId_authSubject: {
            serverProfileId: string;
            authSubject: string;
          };
        };
      }) =>
        users.find(
          (user) =>
            user.authSubject === where.serverProfileId_authSubject.authSubject,
        ) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id) ?? null,
    },
    device: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; userId: string; lifecycle: string };
      }) =>
        devices.find(
          (device) =>
            device.id === where.id &&
            device.userId === where.userId &&
            device.lifecycle === where.lifecycle,
        ) ?? null,
    },
    team: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        teams.find((team) => team.id === where.id) ?? null,
    },
    membership: {
      findFirst: async ({
        where,
      }: {
        where: { teamId?: string; userId?: string; invitationId?: string };
      }) =>
        localMemberships
          .concat(createdMemberships)
          .find((membership) =>
            where.invitationId !== undefined
              ? membership.invitationId === where.invitationId
              : (where.teamId === undefined ||
                  membership.teamId === where.teamId) &&
                (where.userId === undefined ||
                  membership.userId === where.userId),
          ) ?? null,
      findMany: async ({
        where,
      }: {
        where: {
          teamId?: string;
          userId?: string;
          lifecycle?: MembershipLifecycle;
          team?: Readonly<{
            lifecycle: string;
            serverProfileId: string;
          }>;
        };
      }) =>
        localMemberships
          .concat(createdMemberships)
          .filter((membership) => {
            const team = teams.find((entry) => entry.id === membership.teamId);
            return (
              (where.teamId === undefined ||
                membership.teamId === where.teamId) &&
              (where.userId === undefined ||
                membership.userId === where.userId) &&
              (where.lifecycle === undefined ||
                membership.lifecycle === where.lifecycle) &&
              (where.team === undefined ||
                (team?.lifecycle === where.team.lifecycle &&
                  team?.serverProfileId === where.team.serverProfileId))
            );
          })
          .map((membership) => ({
            ...membership,
            user: users.find((user) => user.id === membership.userId) ?? null,
            team: teams.find((entry) => entry.id === membership.teamId) ?? null,
          })),
      create: async ({
        data,
      }: {
        data: {
          id?: string;
          teamId: string;
          userId: string;
          invitationId: string;
          createdAt: Date;
        };
      }) => {
        const membership: StubMembership = {
          id: data.id ?? crypto.randomUUID(),
          teamId: data.teamId,
          userId: data.userId,
          role: "MEMBER",
          lifecycle: "PENDING_KEY_GRANT",
          createdAt: data.createdAt,
          activatedAt: null,
          removedAt: null,
          invitationId: data.invitationId,
        };
        createdMemberships.push(membership);
        return membership;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        localMemberships
          .concat(createdMemberships)
          .find((membership) => membership.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: {
          role?: MembershipRole;
          lifecycle?: MembershipLifecycle;
          removedAt?: Date;
        };
      }) => {
        const membership = localMemberships
          .concat(createdMemberships)
          .find((entry) => entry.id === where.id);
        if (!membership) throw new Error("Membership not found");
        // The persistence layer keeps every Team's last active owner in place
        // with a database trigger; the stub mirrors it so route tests exercise
        // the same guard.
        const nextLifecycle = data.lifecycle ?? membership.lifecycle;
        const nextRole = data.role ?? membership.role;
        const stillActiveOwner =
          nextLifecycle === "ACTIVE" && nextRole === "OWNER";
        const remainingOwners = localMemberships
          .concat(createdMemberships)
          .filter(
            (entry) =>
              entry.teamId === membership.teamId &&
              entry.lifecycle === "ACTIVE" &&
              entry.role === "OWNER" &&
              (entry.id !== membership.id || stillActiveOwner),
          ).length;
        if (
          membership.lifecycle === "ACTIVE" &&
          membership.role === "OWNER" &&
          !stillActiveOwner &&
          remainingOwners < 1
        )
          throw new Error("a Team must retain one active owner");
        if (data.role !== undefined) membership.role = data.role;
        if (data.lifecycle !== undefined) membership.lifecycle = data.lifecycle;
        if (data.removedAt !== undefined) membership.removedAt = data.removedAt;
        return membership;
      },
    },
    membershipInvitation: {
      findFirst: async ({
        where,
      }: {
        where: { teamId?: string; providerSubject?: string; id?: string };
      }) => {
        const matches = localInvitations
          .concat(createdInvitations)
          .filter(
            (invitation) =>
              (where.id === undefined || invitation.id === where.id) &&
              (where.teamId === undefined ||
                invitation.teamId === where.teamId) &&
              (where.providerSubject === undefined ||
                invitation.providerSubject === where.providerSubject),
          );
        matches.sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() ||
            (left.id < right.id ? 1 : -1),
        );
        return matches[0] ?? null;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        localInvitations
          .concat(createdInvitations)
          .find((invitation) => invitation.id === where.id) ?? null,
      findMany: async ({
        where,
      }: {
        where: {
          teamId?: string;
          providerSubject?: string;
          acceptedByUserId?: null;
          expiresAt?: { gt: Date };
          team?: Readonly<{
            lifecycle: string;
            serverProfileId: string;
          }>;
        };
      }) =>
        localInvitations
          .concat(createdInvitations)
          .filter((invitation) => {
            const team = teams.find((entry) => entry.id === invitation.teamId);
            return (
              (where.teamId === undefined ||
                invitation.teamId === where.teamId) &&
              (where.providerSubject === undefined ||
                invitation.providerSubject === where.providerSubject) &&
              (where.acceptedByUserId === undefined ||
                invitation.acceptedByUserId === where.acceptedByUserId) &&
              (where.expiresAt === undefined ||
                invitation.expiresAt > where.expiresAt.gt) &&
              (where.team === undefined ||
                (team?.lifecycle === where.team.lifecycle &&
                  team?.serverProfileId === where.team.serverProfileId))
            );
          })
          .map((invitation) => ({
            ...invitation,
            team: teams.find((entry) => entry.id === invitation.teamId) ?? null,
          })),
      create: async ({
        data,
      }: {
        data: {
          id: string;
          teamId: string;
          providerSubject: string;
          expiresAt: Date;
          createdAt: Date;
        };
      }) => {
        const invitation: StubInvitation = {
          id: data.id,
          teamId: data.teamId,
          providerSubject: data.providerSubject,
          acceptedByUserId: null,
          acceptedAt: null,
          createdAt: data.createdAt,
          expiresAt: data.expiresAt,
        };
        createdInvitations.push(invitation);
        return invitation;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { acceptedByUserId: string; acceptedAt: Date };
      }) => {
        const invitation = localInvitations
          .concat(createdInvitations)
          .find((entry) => entry.id === where.id);
        if (!invitation) throw new Error("invitation not found");
        invitation.acceptedByUserId = data.acceptedByUserId;
        invitation.acceptedAt = data.acceptedAt;
        return invitation;
      },
    },
    operation: {
      createMany: async ({
        data,
      }: {
        data: Array<{
          id: string;
          actorUserId: string;
          actorDeviceId?: string;
          kind: string;
          commandDigest: Uint8Array;
        }>;
        skipDuplicates?: boolean;
      }) => {
        for (const entry of data) {
          if (operations.has(entry.id)) continue;
          operations.set(entry.id, {
            id: entry.id,
            actorUserId: entry.actorUserId,
            actorDeviceId: entry.actorDeviceId ?? null,
            kind: entry.kind,
            commandDigest: entry.commandDigest,
            status: "STAGED",
          });
        }
        return { count: data.length };
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        operations.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status?: string; committedAt?: Date };
      }) => {
        const operation = operations.get(where.id);
        if (!operation) throw new Error("operation not found");
        if (data.status) operation.status = data.status as "COMMITTED";
        return { count: 1 };
      },
    },
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return data;
      },
    },
  };
  return {
    database,
    operations,
    auditEvents,
    createdMemberships,
    createdInvitations,
    localInvitations,
  };
};

const createTestApp = (options: { githubFetch?: typeof fetch } = {}) => {
  const {
    database,
    operations,
    auditEvents,
    createdMemberships,
    createdInvitations,
    localInvitations,
  } = createDatabaseStub();
  const testApp = createApi({
    database: database as never,
    profile,
    auth: createAuthStub(),
    ...(options.githubFetch ? { githubFetch: options.githubFetch } : {}),
  });
  return {
    testApp,
    operations,
    auditEvents,
    createdMemberships,
    createdInvitations,
    localInvitations,
  };
};

const request = (
  testApp: ReturnType<typeof createTestApp>["testApp"],
  path: string,
  options: {
    method?: string;
    token?: string;
    deviceId?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {},
) =>
  testApp.request(`${profile.origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Origin: profile.origin,
      "Cache-Control": "no-store",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.deviceId ? { "X-DotRelay-Device-Id": options.deviceId } : {}),
      ...(options.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : {}),
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

describe("Team membership and invitation routes", () => {
  test("an owner reads the full persisted membership table with pending invitations", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships`,
      { token: "owner-token" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.memberships).toEqual([
      {
        membershipId: MEMBER_M1,
        userId: USER_OWNER,
        name: "Owner Person",
        image: null,
        githubSubject: "1001",
        role: "OWNER",
        lifecycle: "ACTIVE",
        createdAt: t(-30).toISOString(),
        activatedAt: t(-30).toISOString(),
        removedAt: null,
      },
      {
        membershipId: MEMBER_M2,
        userId: USER_MEMBER,
        name: "Member Person",
        image: "https://a/1.png",
        githubSubject: "2002",
        role: "MEMBER",
        lifecycle: "ACTIVE",
        createdAt: t(-20).toISOString(),
        activatedAt: t(-20).toISOString(),
        removedAt: null,
      },
      {
        membershipId: MEMBER_M7,
        userId: USER_ADMIN,
        name: "Admin Person",
        image: null,
        githubSubject: "6006",
        role: "ADMIN",
        lifecycle: "ACTIVE",
        createdAt: t(-18).toISOString(),
        activatedAt: t(-18).toISOString(),
        removedAt: null,
      },
      {
        membershipId: MEMBER_M8,
        userId: USER_OWNER_TWO,
        name: "Second Owner",
        image: null,
        githubSubject: "7007",
        role: "OWNER",
        lifecycle: "ACTIVE",
        createdAt: t(-12).toISOString(),
        activatedAt: t(-12).toISOString(),
        removedAt: null,
      },
      {
        membershipId: MEMBER_M3,
        userId: USER_PENDING,
        name: null,
        image: null,
        githubSubject: "3003",
        role: "MEMBER",
        lifecycle: "PENDING_KEY_GRANT",
        createdAt: t(-2).toISOString(),
        activatedAt: null,
        removedAt: null,
      },
      {
        membershipId: MEMBER_M4,
        userId: USER_OLD,
        name: null,
        image: null,
        githubSubject: "4004",
        role: "MEMBER",
        lifecycle: "REMOVED",
        createdAt: t(-40).toISOString(),
        activatedAt: t(-40).toISOString(),
        removedAt: t(-10).toISOString(),
      },
    ]);
    expect(body.invitations).toEqual([
      {
        invitationId: INV_ACTIVE,
        providerSubject: "583231",
        createdAt: t(-1).toISOString(),
        expiresAt: t(6).toISOString(),
      },
    ]);
  });

  test("a plain member reads only active members, without roles or invitations", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships`,
      { token: "member-token" },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      memberships: [
        {
          membershipId: MEMBER_M1,
          userId: USER_OWNER,
          name: "Owner Person",
          image: null,
          githubSubject: "1001",
          lifecycle: "ACTIVE",
        },
        {
          membershipId: MEMBER_M2,
          userId: USER_MEMBER,
          name: "Member Person",
          image: "https://a/1.png",
          githubSubject: "2002",
          lifecycle: "ACTIVE",
        },
        {
          membershipId: MEMBER_M7,
          userId: USER_ADMIN,
          name: "Admin Person",
          image: null,
          githubSubject: "6006",
          lifecycle: "ACTIVE",
        },
        {
          membershipId: MEMBER_M8,
          userId: USER_OWNER_TWO,
          name: "Second Owner",
          image: null,
          githubSubject: "7007",
          lifecycle: "ACTIVE",
        },
      ],
      invitations: [],
    });
  });

  test("a member awaiting its key grant still reads the Team table", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships`,
      { token: "pending-token" },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(
      (body.memberships as Array<Record<string, unknown>>).map(
        (row) => row.membershipId,
      ),
    ).toEqual([MEMBER_M1, MEMBER_M2, MEMBER_M7, MEMBER_M8]);
    expect(body.invitations).toEqual([]);
  });

  test("a User outside the Team cannot read its membership table", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships`,
      { token: "invitee-token" },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  test("unknown and archived Teams answer as problems", async () => {
    const { testApp } = createTestApp();
    const unknown = await request(
      testApp,
      `/api/v1/teams/${"e0f1a2b3-c4d5-4e6f-8a7b-9c0d1e2f3a4b"}/memberships`,
      { token: "owner-token" },
    );
    const archived = await request(
      testApp,
      `/api/v1/teams/${TEAM_ARCHIVED}/memberships`,
      { token: "owner-token" },
    );

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "resource_not_found" });
    expect(archived.status).toBeGreaterThanOrEqual(400);
    expect(await archived.json()).toMatchObject({ code: "archived_resource" });
  });

  test("membership reads require a signed-in session", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships`,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "authentication_required",
    });
  });

  test("pending invitations reach owners and admins; other members see an empty list", async () => {
    const { testApp } = createTestApp();
    const owner = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/invitations`,
      { token: "owner-token" },
    );
    const member = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/invitations`,
      { token: "member-token" },
    );

    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({
      invitations: [
        {
          invitationId: INV_ACTIVE,
          providerSubject: "583231",
          createdAt: t(-1).toISOString(),
          expiresAt: t(6).toISOString(),
        },
      ],
    });
    expect(member.status).toBe(200);
    expect(await member.json()).toEqual({ invitations: [] });
  });

  test("a User outside the Team cannot read its pending invitations", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/invitations`,
      { token: "invitee-token" },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  test("an owner creates an invitation through the service and the record persists", async () => {
    const { testApp, auditEvents, createdInvitations } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/invitations`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "f0000000-0000-4000-8000-000000000001",
        body: { providerSubject: "583231" },
      },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.teamId).toBe(TEAM_A);
    expect(body.providerSubject).toBe("583231");
    expect(typeof body.invitationId).toBe("string");
    const created = (await createdInvitations[0]) as StubInvitation;
    expect(created.id).toBe(body.invitationId as string);
    expect(created.teamId).toBe(TEAM_A);
    expect(created.providerSubject).toBe("583231");
    expect(created.expiresAt.getTime() - created.createdAt.getTime()).toBe(
      7 * DAY,
    );
    expect(auditEvents).toEqual([
      expect.objectContaining({
        kind: "MEMBERSHIP_INVITED",
        actorUserId: USER_OWNER,
        actorDeviceId: DEVICE_OWNER,
        entityKind: "INVITATION",
        entityId: created.id,
      }),
    ]);
  });

  test("a plain member cannot create an invitation", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/invitations`,
      {
        method: "POST",
        token: "member-token",
        deviceId: DEVICE_MEMBER,
        idempotencyKey: "f0000000-0000-4000-8000-000000000002",
        body: { providerSubject: "583231" },
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  test("invitation creation requires the browser Device, not just the session", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/invitations`,
      {
        method: "POST",
        token: "owner-token",
        idempotencyKey: "f0000000-0000-4000-8000-000000000003",
        body: { providerSubject: "583231" },
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  test("an invitation must address a stable GitHub provider subject", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/invitations`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "f0000000-0000-4000-8000-000000000004",
        body: { providerSubject: "octocat" },
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  test("replaying an invitation command reports the original invitation", async () => {
    const { testApp, createdInvitations } = createTestApp();
    const first = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/invitations`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "f0000000-0000-4000-8000-000000000005",
        body: { providerSubject: "583231" },
      },
    );
    const replay = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/invitations`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "f0000000-0000-4000-8000-000000000005",
        body: { providerSubject: "583231" },
      },
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    const firstBody = (await first.clone().json()) as Record<string, unknown>;
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(replayBody.invitationId).toBe(firstBody.invitationId);
    expect(createdInvitations).toHaveLength(1);
  });

  test("an owner resolves a familiar GitHub login to its stable subject", async () => {
    const fetchImpl = (async (_input: string | URL | Request) =>
      Response.json({ id: 583231, login: "octocat" })) as typeof fetch;
    const { testApp } = createTestApp({ githubFetch: fetchImpl });
    const response = await request(testApp, "/api/v1/github-users/resolve", {
      method: "POST",
      token: "owner-token",
      deviceId: DEVICE_OWNER,
      body: { login: "octocat" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      login: "octocat",
      githubUserId: "583231",
    });
  });

  test("an unresolvable GitHub login answers as not found, never as an outage", async () => {
    const fetchImpl = (async (_input: string | URL | Request) =>
      new Response("nope", { status: 404 })) as typeof fetch;
    const { testApp } = createTestApp({ githubFetch: fetchImpl });
    const response = await request(testApp, "/api/v1/github-users/resolve", {
      method: "POST",
      token: "owner-token",
      deviceId: DEVICE_OWNER,
      body: { login: "nobody-here" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "github_identity_not_found",
    });
  });

  test("the acting User sees the invitations addressed to it and its pending Teams", async () => {
    const { testApp } = createTestApp();
    const response = await request(testApp, "/api/v1/invitations", {
      token: "invitee-token",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      invitations: [
        {
          invitationId: INV_ACTIVE,
          teamId: TEAM_A,
          teamName: "Alpha",
          providerSubject: "583231",
          createdAt: t(-1).toISOString(),
          expiresAt: t(6).toISOString(),
        },
      ],
      pendingMemberships: [{ teamId: TEAM_B, teamName: "Beta" }],
    });
  });

  test("the invitee accepts an invitation and the membership goes pending", async () => {
    const { testApp, createdMemberships, operations, localInvitations } =
      createTestApp();
    const response = await request(
      testApp,
      `/api/v1/invitations/${INV_ACTIVE}/accept`,
      {
        method: "POST",
        token: "invitee-token",
        idempotencyKey: "a0000000-0000-4000-8000-000000000001",
      },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.teamId).toBe(TEAM_A);
    expect(body.lifecycle).toBe("PENDING_KEY_GRANT");
    expect(typeof body.membershipId).toBe("string");
    expect(createdMemberships).toHaveLength(1);
    expect(createdMemberships[0]?.userId).toBe(USER_INVITEE);
    expect(createdMemberships[0]?.invitationId).toBe(INV_ACTIVE);
    const invitation = localInvitations.find(
      (entry) => entry.id === INV_ACTIVE,
    );
    expect(invitation?.acceptedByUserId).toBe(USER_INVITEE);
    expect(operations.get("a0000000-0000-4000-8000-000000000001")?.status).toBe(
      "COMMITTED",
    );
  });

  test("accepting needs no Device, but the invitation must address the acting User", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/invitations/${INV_OTHER}/accept`,
      {
        method: "POST",
        token: "invitee-token",
        idempotencyKey: "a0000000-0000-4000-8000-000000000002",
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  test("an expired or used invitation cannot be accepted again", async () => {
    const { testApp } = createTestApp();
    for (const [id, key] of [
      [INV_EXPIRED, "a0000000-0000-4000-8000-000000000003"],
      [INV_ACCEPTED, "a0000000-0000-4000-8000-000000000004"],
    ] as const) {
      const response = await request(
        testApp,
        `/api/v1/invitations/${id}/accept`,
        {
          method: "POST",
          token: "invitee-token",
          idempotencyKey: key,
        },
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        code: "invitation_expired",
      });
    }
  });

  test("an unknown invitation cannot be accepted", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/invitations/${"e0f1a2b3-c4d5-4e6f-8a7b-9c0d1e2f3a4b"}/accept`,
      {
        method: "POST",
        token: "invitee-token",
        idempotencyKey: "a0000000-0000-4000-8000-000000000005",
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "resource_not_found" });
  });

  test("replaying an acceptance reports the original membership", async () => {
    const { testApp, createdMemberships } = createTestApp();
    const first = await request(
      testApp,
      `/api/v1/invitations/${INV_ACTIVE}/accept`,
      {
        method: "POST",
        token: "invitee-token",
        idempotencyKey: "a0000000-0000-4000-8000-000000000006",
      },
    );
    const replay = await request(
      testApp,
      `/api/v1/invitations/${INV_ACTIVE}/accept`,
      {
        method: "POST",
        token: "invitee-token",
        idempotencyKey: "a0000000-0000-4000-8000-000000000006",
      },
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    const firstBody = (await first.clone().json()) as Record<string, unknown>;
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(replayBody.membershipId).toBe(firstBody.membershipId);
    expect(createdMemberships).toHaveLength(1);
  });
});
describe("Team membership role and removal routes", () => {
  test("an owner changes a member's role and the record persists", async () => {
    const { testApp, auditEvents } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/role`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "b0000000-0000-4000-8000-000000000001",
        body: { role: "ADMIN" },
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      membershipId: MEMBER_M2,
      teamId: TEAM_A,
      role: "ADMIN",
      lifecycle: "ACTIVE",
    });
    expect(auditEvents).toEqual([
      expect.objectContaining({
        kind: "MEMBERSHIP_ROLE_CHANGED",
        actorUserId: USER_OWNER,
        actorDeviceId: DEVICE_OWNER,
        entityKind: "MEMBERSHIP",
        entityId: MEMBER_M2,
      }),
    ]);
    // The change is the Team's record: a fresh privileged read sees it.
    const refetch = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships`,
      { token: "owner-token" },
    );
    const refetchBody = (await refetch.json()) as {
      memberships: Array<Record<string, unknown>>;
    };
    expect(
      refetchBody.memberships.find((row) => row.membershipId === MEMBER_M2)
        ?.role,
    ).toBe("ADMIN");
  });

  test("an owner may demote a second owner while one stays active", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M8}/role`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "b0000000-0000-4000-8000-000000000002",
        body: { role: "ADMIN" },
      },
    );

    expect(response.status).toBe(201);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      membershipId: MEMBER_M8,
      role: "ADMIN",
    });
  });

  test("replaying a role change reports the membership's current state", async () => {
    const { testApp } = createTestApp();
    const first = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/role`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "b0000000-0000-4000-8000-000000000003",
        body: { role: "ADMIN" },
      },
    );
    const replay = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/role`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "b0000000-0000-4000-8000-000000000003",
        body: { role: "ADMIN" },
      },
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      membershipId: MEMBER_M2,
      teamId: TEAM_A,
      role: "ADMIN",
      lifecycle: "ACTIVE",
    });
  });

  test("an owner cannot demote a Team's last active owner", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_B}/memberships/${MEMBER_M5}/role`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "b0000000-0000-4000-8000-000000000004",
        body: { role: "ADMIN" },
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "last_owner_protection",
    });
  });

  test("an owner removes a member and the removal is the Team's record", async () => {
    const { testApp, auditEvents } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/remove`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "c0000000-0000-4000-8000-000000000001",
        body: {},
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      membershipId: MEMBER_M2,
      teamId: TEAM_A,
      lifecycle: "REMOVED",
    });
    expect(auditEvents).toEqual([
      expect.objectContaining({
        kind: "MEMBERSHIP_REMOVED",
        actorUserId: USER_OWNER,
        actorDeviceId: DEVICE_OWNER,
        entityKind: "MEMBERSHIP",
        entityId: MEMBER_M2,
      }),
    ]);
    const refetch = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships`,
      { token: "owner-token" },
    );
    const refetchBody = (await refetch.json()) as {
      memberships: Array<Record<string, unknown>>;
    };
    const removed = refetchBody.memberships.find(
      (row) => row.membershipId === MEMBER_M2,
    );
    expect(removed?.lifecycle).toBe("REMOVED");
  });

  test("an owner may remove a second owner while one stays active", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M8}/remove`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "c0000000-0000-4000-8000-000000000002",
        body: {},
      },
    );

    expect(response.status).toBe(201);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      membershipId: MEMBER_M8,
      lifecycle: "REMOVED",
    });
  });

  test("an owner cannot remove a Team's last active owner", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/teams/${TEAM_B}/memberships/${MEMBER_M5}/remove`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "c0000000-0000-4000-8000-000000000003",
        body: {},
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "last_owner_protection",
    });
  });

  test("replaying a removal reports the state conflict", async () => {
    const { testApp } = createTestApp();
    const first = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/remove`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "c0000000-0000-4000-8000-000000000004",
        body: {},
      },
    );
    const replay = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/remove`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "c0000000-0000-4000-8000-000000000004",
        body: {},
      },
    );
    // The removal is the Team's record: the persistence layer checks the
    // membership's lifecycle before its idempotency key, so the replay of a
    // removal the membership already completed reports the conflict.
    expect(first.status).toBe(201);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: "state_conflict" });
  });

  test("an admin removes a member but cannot change roles", async () => {
    const { testApp } = createTestApp();
    // The re-role is attempted first, while the Membership is still active:
    // it must be refused by the policy before the removal makes it moot.
    const promotion = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/role`,
      {
        method: "POST",
        token: "admin-token",
        deviceId: DEVICE_ADMIN,
        idempotencyKey: "d0000000-0000-4000-8000-000000000002",
        body: { role: "ADMIN" },
      },
    );
    const removal = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/remove`,
      {
        method: "POST",
        token: "admin-token",
        deviceId: DEVICE_ADMIN,
        idempotencyKey: "d0000000-0000-4000-8000-000000000001",
        body: {},
      },
    );

    expect(promotion.status).toBe(403);
    expect(await promotion.json()).toMatchObject({ code: "forbidden" });
    expect(removal.status).toBe(201);
    expect(await removal.json()).toMatchObject({ lifecycle: "REMOVED" });
  });

  test("an admin cannot remove or re-role owners", async () => {
    const { testApp } = createTestApp();
    const removal = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M1}/remove`,
      {
        method: "POST",
        token: "admin-token",
        deviceId: DEVICE_ADMIN,
        idempotencyKey: "d0000000-0000-4000-8000-000000000003",
        body: {},
      },
    );
    const reRole = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M1}/role`,
      {
        method: "POST",
        token: "admin-token",
        deviceId: DEVICE_ADMIN,
        idempotencyKey: "d0000000-0000-4000-8000-000000000004",
        body: { role: "MEMBER" },
      },
    );

    expect(removal.status).toBe(403);
    expect(await removal.json()).toMatchObject({ code: "forbidden" });
    expect(reRole.status).toBe(403);
    expect(await reRole.json()).toMatchObject({ code: "forbidden" });
  });

  test("a plain member cannot change roles or remove members", async () => {
    const { testApp } = createTestApp();
    const reRole = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/role`,
      {
        method: "POST",
        token: "member-token",
        deviceId: DEVICE_MEMBER,
        idempotencyKey: "e0000000-0000-4000-8000-000000000001",
        body: { role: "ADMIN" },
      },
    );
    const removal = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/remove`,
      {
        method: "POST",
        token: "member-token",
        deviceId: DEVICE_MEMBER,
        idempotencyKey: "e0000000-0000-4000-8000-000000000002",
        body: {},
      },
    );

    expect(reRole.status).toBe(403);
    expect(await reRole.json()).toMatchObject({ code: "forbidden" });
    expect(removal.status).toBe(403);
    expect(await removal.json()).toMatchObject({ code: "forbidden" });
  });

  test("unknown memberships answer as not found on both routes", async () => {
    const { testApp } = createTestApp();
    const unknown = "e0f1a2b3-c4d5-4e6f-8a7b-9c0d1e2f3a4b";
    const reRole = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${unknown}/role`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "f0000000-0000-4000-8000-000000000001",
        body: { role: "ADMIN" },
      },
    );
    const removal = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${unknown}/remove`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "f0000000-0000-4000-8000-000000000002",
        body: {},
      },
    );

    expect(reRole.status).toBe(404);
    expect(await reRole.json()).toMatchObject({ code: "resource_not_found" });
    expect(removal.status).toBe(404);
    expect(await removal.json()).toMatchObject({ code: "resource_not_found" });
  });

  test("a membership from another Team answers not found even for an owner of both", async () => {
    // USER_OWNER is OWNER of both TEAM_A and TEAM_B, so this is the
    // maximally-privileged probe: presenting a valid TEAM_B membership under
    // a TEAM_A URL must still 404 (it does not exist in the URL's Team),
    // and must not mutate the foreign membership or append an audit fact.
    const { testApp, auditEvents } = createTestApp();
    const reRole = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M6}/role`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "f0000000-0000-4000-8000-000000000001",
        body: { role: "ADMIN" },
      },
    );
    const removal = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M6}/remove`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "f0000000-0000-4000-8000-000000000002",
        body: {},
      },
    );

    expect(reRole.status).toBe(404);
    expect(await reRole.json()).toMatchObject({ code: "resource_not_found" });
    expect(removal.status).toBe(404);
    expect(await removal.json()).toMatchObject({ code: "resource_not_found" });
    // No audit fact was appended for the foreign membership: the scoping
    // guard rejected the request before any mutation could be committed.
    expect(auditEvents.filter((event) => event.entityId === MEMBER_M6)).toEqual(
      [],
    );
  });
  test("membership mutations require the browser Device, not just the session", async () => {
    const { testApp } = createTestApp();
    const reRole = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/role`,
      {
        method: "POST",
        token: "owner-token",
        idempotencyKey: "f0000000-0000-4000-8000-000000000003",
        body: { role: "ADMIN" },
      },
    );
    const removal = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/remove`,
      {
        method: "POST",
        token: "owner-token",
        idempotencyKey: "f0000000-0000-4000-8000-000000000004",
        body: {},
      },
    );

    expect(reRole.status).toBe(400);
    expect(await reRole.json()).toMatchObject({ code: "invalid_request" });
    expect(removal.status).toBe(400);
    expect(await removal.json()).toMatchObject({ code: "invalid_request" });
  });

  test("role changes validate the requested role and removals need a JSON body", async () => {
    const { testApp } = createTestApp();
    const badRole = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/role`,
      {
        method: "POST",
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "f0000000-0000-4000-8000-000000000005",
        body: { role: "SUPERUSER" },
      },
    );
    const noBody = await request(
      testApp,
      `/api/v1/teams/${TEAM_A}/memberships/${MEMBER_M2}/remove`,
      { method: "POST", token: "owner-token", deviceId: DEVICE_OWNER },
    );

    expect(badRole.status).toBe(400);
    expect(await badRole.json()).toMatchObject({ code: "invalid_request" });
    expect(noBody.status).toBe(400);
    expect(await noBody.json()).toMatchObject({ code: "invalid_request" });
  });
});
