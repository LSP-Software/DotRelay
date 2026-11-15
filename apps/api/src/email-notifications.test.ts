import { expect, test } from "bun:test";
import {
  DEFAULT_EMAIL_FROM,
  type EmailMessage,
  EmailSendError,
  type EmailTransport,
} from "./email";
import { createEmailNotifier, type EmailEvent } from "./email-notifications";
import {
  createInMemoryDiagnosticSink,
  createServerCorrelationId,
} from "./observability";

const TEAM = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const ADMIN = "44444444-4444-4444-8444-444444444444";
const MEMBER = "55555555-5555-4555-8555-555555555555";
const INVITEE = "66666666-6666-4666-8666-666666666666";
const NOREPLY = "77777777-7777-4777-8777-777777777777";
const INVITATION = "99999999-9999-4999-8999-999999999999";
const UNKNOWN_INVITATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOREPLY_INVITATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCEPTED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SHARED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROJECT = "e1111111-e111-4e11-8e11-e1111111e111";
const OPERATION = "f1111111-f111-4f11-8f11-f1111111f111";

const users = [
  {
    id: OWNER,
    authSubject: "auth-owner",
    githubSubject: "1",
    email: "owner@example.com",
    name: "Olive Owner",
  },
  {
    id: ADMIN,
    authSubject: "auth-admin",
    githubSubject: "2",
    email: "admin@example.com",
    name: "Ada Admin",
  },
  {
    id: MEMBER,
    authSubject: "auth-member",
    githubSubject: "3",
    email: "member@example.com",
    name: "Max Member",
  },
  {
    id: INVITEE,
    authSubject: "auth-invitee",
    githubSubject: "4",
    email: "invitee@example.com",
    name: "<b>Ivy</b>",
  },
  {
    id: NOREPLY,
    authSubject: "auth-noreply",
    githubSubject: "5",
    email: "5+ghost@users.noreply.github.com",
    name: "Ghost",
  },
];
const memberships = [
  {
    id: "m-owner",
    teamId: TEAM,
    userId: OWNER,
    role: "OWNER",
    lifecycle: "ACTIVE",
  },
  {
    id: "m-admin",
    teamId: TEAM,
    userId: ADMIN,
    role: "ADMIN",
    lifecycle: "ACTIVE",
  },
  {
    id: "m-member",
    teamId: TEAM,
    userId: MEMBER,
    role: "MEMBER",
    lifecycle: "ACTIVE",
  },
  {
    id: ACCEPTED,
    teamId: TEAM,
    userId: INVITEE,
    role: "MEMBER",
    lifecycle: "PENDING_KEY_GRANT",
  },
  {
    id: SHARED,
    teamId: TEAM,
    userId: MEMBER,
    role: "MEMBER",
    lifecycle: "ACTIVE",
  },
];
const invitations = [
  { id: INVITATION, providerSubject: "4" },
  { id: UNKNOWN_INVITATION, providerSubject: "999" },
  { id: NOREPLY_INVITATION, providerSubject: "5" },
];
const team = { name: "Ops & <Friends>", serverProfileId: "profile" };

const database = {
  user: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      users.filter((user) => where.id.in.includes(user.id)),
    findUnique: async ({ where }: { where: { id: string } }) =>
      users.find((user) => user.id === where.id) ?? null,
    findFirst: async ({ where }: { where: { githubSubject: string } }) =>
      users.find((user) => user.githubSubject === where.githubSubject) ?? null,
  },
  authUser: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      users
        .filter((user) => where.id.in.includes(user.authSubject))
        .map((user) => ({
          id: user.authSubject,
          email: user.email,
          name: user.name,
        })),
    findUnique: async ({ where }: { where: { id: string } }) => {
      const user = users.find((entry) => entry.authSubject === where.id);
      return user ? { name: user.name } : null;
    },
  },
  membershipInvitation: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const invitation = invitations.find((entry) => entry.id === where.id);
      return invitation
        ? { ...invitation, expiresAt: new Date("2026-11-22T10:00:00Z"), team }
        : null;
    },
  },
  membership: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const membership = memberships.find((entry) => entry.id === where.id);
      const user = users.find((entry) => entry.id === membership?.userId);
      return membership
        ? { ...membership, team, user: { githubSubject: user?.githubSubject } }
        : null;
    },
    findMany: async ({
      where,
    }: {
      where: {
        teamId: string;
        userId: { not: string };
        role: { in: string[] };
      };
    }) =>
      memberships.filter(
        (entry) =>
          entry.teamId === where.teamId &&
          entry.lifecycle === "ACTIVE" &&
          where.role.in.includes(entry.role) &&
          entry.userId !== where.userId.not,
      ),
  },
  project: {
    findMany: async () => [{ githubRepositoryId: 4242n }],
  },
  gitHubLogin: {
    findUnique: async ({ where }: { where: { githubSubject: string } }) =>
      where.githubSubject === "4" ? { login: "ivy-invitee" } : null,
  },
};

const setup = (
  options: {
    send?: (message: EmailMessage) => Promise<void>;
    enabled?: boolean;
  } = {},
) => {
  const sent: EmailMessage[] = [];
  const transport: EmailTransport = {
    send:
      options.send ??
      (async (message) => {
        sent.push(message);
      }),
  };
  const diagnostics = createInMemoryDiagnosticSink();
  const sleeps: number[] = [];
  const notifier = createEmailNotifier({
    database: database as never,
    profile: { webOrigin: "https://dotrelay.dev" },
    config: {
      apiKey: options.enabled === false ? null : "re_fixture",
      from: DEFAULT_EMAIL_FROM,
      supportAddress: "support@dotrelay.dev",
    },
    transport: options.enabled === false ? null : transport,
    diagnostics,
    resolveProjectName: async () => "octo/api",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  // The sink only accepts correlation ids the process issued.
  createServerCorrelationId();
  return { notifier, sent, diagnostics, sleeps };
};

const invitationEvent: EmailEvent = {
  kind: "invitation",
  invitationId: INVITATION,
  inviterUserId: OWNER,
};

test("an invitation emails the invitee's stored address with the inviter and Team", async () => {
  const { notifier, sent, diagnostics } = setup();
  notifier.notify(invitationEvent);
  // Nothing is sent synchronously: the response is never held up.
  expect(sent).toHaveLength(0);
  await notifier.drain();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe("invitee@example.com");
  expect(sent[0]?.idempotencyKey).toBe(`invitation/${INVITATION}/${INVITEE}`);
  expect(sent[0]?.text).toContain("Olive Owner invited you");
  expect(sent[0]?.text).toContain("Ops & <Friends>");
  expect(sent[0]?.html).toContain("Ops &amp; &lt;Friends&gt;");
  expect(sent[0]?.text).toContain("https://dotrelay.dev/workspace");
  expect(diagnostics.records()).toEqual([
    expect.objectContaining({
      eventName: "api.email.sent",
      outcome: "success",
      emailKind: "invitation",
    }),
  ]);
});

test("an invitee with no DotRelay account or only a GitHub noreply address is skipped", async () => {
  const { notifier, sent, diagnostics } = setup();
  notifier.notify({ ...invitationEvent, invitationId: UNKNOWN_INVITATION });
  notifier.notify({ ...invitationEvent, invitationId: NOREPLY_INVITATION });
  await notifier.drain();
  expect(sent).toHaveLength(0);
  expect(
    diagnostics
      .records()
      .map((record) => [record.eventName, record.emailReason]),
  ).toEqual([
    ["api.email.skipped", "no_recipient"],
    ["api.email.skipped", "no_address"],
  ]);
});

test("an acceptance emails each active owner and admin, separately, but not the new Member", async () => {
  const { notifier, sent } = setup();
  notifier.notify({ kind: "invitation_accepted", membershipId: ACCEPTED });
  await notifier.drain();
  expect(sent.map((message) => message.to).sort()).toEqual([
    "admin@example.com",
    "owner@example.com",
  ]);
  for (const message of sent) {
    expect(message.text).toContain("<b>Ivy</b> joined");
    expect(message.html).toContain("&lt;b&gt;Ivy&lt;/b&gt; joined");
    expect(message.html).not.toContain("<b>Ivy</b>");
    expect(message.text).toContain(
      `dotrelay team share-keys ivy-invitee --team ${TEAM}`,
    );
    expect(message.text).toContain(
      `https://dotrelay.dev/workspace?team=${TEAM}&view=team`,
    );
  }
});

test("shared keys send one email per operation with the Project names", async () => {
  const { notifier, sent } = setup();
  const event: EmailEvent = {
    kind: "keys_shared",
    operationId: OPERATION,
    teamId: TEAM,
    membershipId: SHARED,
    projectIds: [PROJECT],
    actorUserId: OWNER,
  };
  notifier.notify(event);
  await notifier.drain();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe("member@example.com");
  expect(sent[0]?.subject).toBe("You can now pull octo/api with DotRelay");
  expect(sent[0]?.text).toContain("dotrelay pull");
  expect(sent[0]?.idempotencyKey).toBe(`keys-shared/${OPERATION}/${MEMBER}`);
  notifier.notify({ ...event, projectIds: [] });
  await notifier.drain();
  expect(sent).toHaveLength(1);
});

test("without RESEND_API_KEY nothing is sent or recorded", async () => {
  const { notifier, sent, diagnostics } = setup({ enabled: false });
  notifier.notify(invitationEvent);
  await notifier.drain();
  expect(sent).toHaveLength(0);
  expect(diagnostics.records()).toHaveLength(0);
});

test("a transient failure is retried once with the same idempotency key, then recorded", async () => {
  const keys: string[] = [];
  const { notifier, diagnostics, sleeps } = setup({
    send: async (message) => {
      keys.push(message.idempotencyKey);
      throw new EmailSendError("server_error");
    },
  });
  notifier.notify(invitationEvent);
  await notifier.drain();
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
  expect(sleeps).toHaveLength(1);
  expect(diagnostics.records()).toEqual([
    expect.objectContaining({
      eventName: "api.email.failed",
      outcome: "failure",
      emailKind: "invitation",
      emailReason: "server_error",
    }),
  ]);
});

test("a rejected send is not retried, and a lookup failure is recorded", async () => {
  let attempts = 0;
  const { notifier, diagnostics } = setup({
    send: async () => {
      attempts += 1;
      throw new EmailSendError("rejected");
    },
  });
  notifier.notify(invitationEvent);
  notifier.notify({ kind: "invitation_accepted", membershipId: "missing" });
  await notifier.drain();
  expect(attempts).toBe(1);
  const broken = createEmailNotifier({
    database: {} as never,
    profile: { webOrigin: "https://dotrelay.dev" },
    config: {
      apiKey: "re_fixture",
      from: DEFAULT_EMAIL_FROM,
      supportAddress: "s@dotrelay.dev",
    },
    transport: { send: async () => undefined },
    diagnostics,
  });
  broken.notify(invitationEvent);
  await broken.drain();
  expect(diagnostics.records().map((record) => record.emailReason)).toEqual([
    "rejected",
    "no_recipient",
    "lookup_failed",
  ]);
});

test("diagnostics never carry addresses, links, names or keys", async () => {
  const { notifier, diagnostics } = setup({
    send: async () => {
      throw new Error("invitee@example.com re_fixture https://dotrelay.dev");
    },
  });
  notifier.notify(invitationEvent);
  notifier.notify({ kind: "invitation_accepted", membershipId: ACCEPTED });
  await notifier.drain();
  const serialized = JSON.stringify(diagnostics.records());
  expect(diagnostics.records().length).toBeGreaterThan(0);
  for (const secret of ["@", "re_fixture", "https://", "Ivy", "Ops"])
    expect(serialized).not.toContain(secret);
});
