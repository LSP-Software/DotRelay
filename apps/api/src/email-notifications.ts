// Post-commit transactional email. Routes call `notify` once their database
// transaction has committed; the lookups, rendering and sending run in the
// background, so a slow or failed send never fails or delays the response.
// Outcomes are reported only as allowlisted diagnostics: an email kind and a
// bounded reason, never an address, link, key or provider response.
import type { DatabaseClient } from "@dotrelay/database";
import {
  type EmailConfig,
  type EmailFailureReason,
  type EmailMessage,
  EmailSendError,
  type EmailTransport,
  isEmailAddress,
} from "./email";
import {
  type RenderedEmail,
  renderInvitationAcceptedEmail,
  renderInvitationEmail,
  renderKeysSharedEmail,
} from "./email-templates";
import {
  createServerCorrelationId,
  type ServerDiagnosticEmailKind,
  type ServerDiagnosticEmailReason,
  type ServerDiagnosticEventName,
  type ServerDiagnosticSink,
} from "./observability";
import type { ServerProfileConfig } from "./profile";

export type EmailEvent =
  | Readonly<{
      readonly kind: "invitation";
      readonly invitationId: string;
      readonly inviterUserId: string;
    }>
  | Readonly<{
      readonly kind: "keys_shared";
      readonly operationId: string;
      readonly teamId: string;
      readonly membershipId: string;
      readonly projectIds: readonly string[];
      readonly actorUserId: string;
    }>
  | Readonly<{
      readonly kind: "invitation_accepted";
      readonly membershipId: string;
    }>;

export type EmailNotifier = Readonly<{
  /** Queues the event's emails. Never throws and never waits. */
  readonly notify: (event: EmailEvent) => void;
  /** Resolves once every queued email has finished (tests, shutdown). */
  readonly drain: () => Promise<void>;
}>;

export const disabledEmailNotifier: EmailNotifier = Object.freeze({
  notify: () => undefined,
  drain: async () => undefined,
});

/** Best-effort Project display name; undefined falls back to the repo id. */
export type ProjectNameResolver = (
  input: Readonly<{
    readonly githubRepositoryId: string;
    readonly actorUserId: string;
  }>,
) => Promise<string | undefined>;

type Recipient = Readonly<{ readonly userId: string; readonly email: string }>;

type Delivery = Readonly<{
  readonly recipient: Recipient;
  readonly email: RenderedEmail;
  readonly idempotencyKey: string;
}>;

type Plan = Readonly<{
  readonly deliveries: readonly Delivery[];
  readonly skipped: readonly ServerDiagnosticEmailReason[];
}>;

const MAX_PENDING_EVENTS = 200;
const RETRY_DELAY_MS = 2_000;
const RETRYABLE: ReadonlySet<EmailFailureReason> = new Set([
  "timeout",
  "network",
  "rate_limited",
  "server_error",
]);
const GITHUB_NOREPLY_SUFFIX = "@users.noreply.github.com";

const deliverableAddress = (email: string | null | undefined) =>
  typeof email === "string" &&
  isEmailAddress(email) &&
  !email.toLowerCase().endsWith(GITHUB_NOREPLY_SUFFIX);

const failureReason = (error: unknown): EmailFailureReason =>
  error instanceof EmailSendError ? error.reason : "network";

export const createEmailNotifier = ({
  database,
  profile,
  config,
  transport,
  diagnostics,
  resolveProjectName = async () => undefined,
  sleep = (ms: number) => Bun.sleep(ms),
}: Readonly<{
  readonly database: DatabaseClient;
  readonly profile: Pick<ServerProfileConfig, "webOrigin">;
  readonly config: EmailConfig;
  /** Null disables sending (no RESEND_API_KEY). */
  readonly transport: EmailTransport | null;
  readonly diagnostics: ServerDiagnosticSink;
  readonly resolveProjectName?: ProjectNameResolver;
  readonly sleep?: (ms: number) => Promise<void>;
}>): EmailNotifier => {
  if (transport === null) return disabledEmailNotifier;
  const pending = new Set<Promise<void>>();
  const webUrl = (path: string, search?: Record<string, string>) => {
    const url = new URL(path, profile.webOrigin);
    for (const [name, value] of Object.entries(search ?? {}))
      url.searchParams.set(name, value);
    return url.toString();
  };

  const emit = (
    eventName: ServerDiagnosticEventName,
    emailKind: ServerDiagnosticEmailKind,
    details: Readonly<{
      readonly outcome?: "success" | "failure";
      readonly emailReason?: ServerDiagnosticEmailReason;
      readonly durationMs?: number;
    }>,
  ) => {
    try {
      diagnostics.emit({
        schemaVersion: 1,
        eventName,
        correlationId: createServerCorrelationId(),
        emailKind,
        ...details,
      });
    } catch {
      // Losing diagnostics must never affect delivery.
    }
  };

  const recipientsFor = async (userIds: readonly string[]) => {
    if (userIds.length === 0) return new Map<string, string | null>();
    const users = await database.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, authSubject: true },
    });
    const authUsers = await database.authUser.findMany({
      where: { id: { in: users.map((user) => user.authSubject) } },
      select: { id: true, email: true, name: true },
    });
    const byAuthSubject = new Map(authUsers.map((user) => [user.id, user]));
    return new Map(
      users.map((user) => [
        user.id,
        byAuthSubject.get(user.authSubject)?.email ?? null,
      ]),
    );
  };

  const displayNameFor = async (userId: string) => {
    const user = await database.user.findUnique({
      where: { id: userId },
      select: { authSubject: true },
    });
    if (!user) return null;
    const authUser = await database.authUser.findUnique({
      where: { id: user.authSubject },
      select: { name: true },
    });
    return authUser?.name?.trim() ? authUser.name : null;
  };

  const planInvitation = async (
    event: Extract<EmailEvent, { kind: "invitation" }>,
  ): Promise<Plan> => {
    const invitation = await database.membershipInvitation.findUnique({
      where: { id: event.invitationId },
      select: {
        providerSubject: true,
        expiresAt: true,
        team: { select: { name: true, serverProfileId: true } },
      },
    });
    if (!invitation) return { deliveries: [], skipped: ["no_recipient"] };
    // Invitations address a GitHub id. Only an invitee who already signed in
    // to DotRelay has a stored email address; anyone else is not emailed.
    const invitee = await database.user.findFirst({
      where: {
        serverProfileId: invitation.team.serverProfileId,
        githubSubject: invitation.providerSubject,
      },
      select: { id: true },
    });
    if (!invitee) return { deliveries: [], skipped: ["no_recipient"] };
    const email = (await recipientsFor([invitee.id])).get(invitee.id);
    if (!deliverableAddress(email))
      return { deliveries: [], skipped: ["no_address"] };
    return {
      deliveries: [
        {
          recipient: { userId: invitee.id, email: email as string },
          idempotencyKey: `invitation/${event.invitationId}/${invitee.id}`,
          email: renderInvitationEmail({
            teamName: invitation.team.name,
            inviterName: await displayNameFor(event.inviterUserId),
            expiresAt: invitation.expiresAt,
            acceptUrl: webUrl("/workspace"),
            supportAddress: config.supportAddress,
          }),
        },
      ],
      skipped: [],
    };
  };

  const planKeysShared = async (
    event: Extract<EmailEvent, { kind: "keys_shared" }>,
  ): Promise<Plan> => {
    if (event.projectIds.length === 0) return { deliveries: [], skipped: [] };
    const membership = await database.membership.findUnique({
      where: { id: event.membershipId },
      select: { userId: true, team: { select: { name: true } } },
    });
    if (!membership) return { deliveries: [], skipped: ["no_recipient"] };
    const email = (await recipientsFor([membership.userId])).get(
      membership.userId,
    );
    if (!deliverableAddress(email))
      return { deliveries: [], skipped: ["no_address"] };
    const projects = await database.project.findMany({
      where: { id: { in: [...event.projectIds] } },
      select: { githubRepositoryId: true },
      orderBy: { createdAt: "asc" },
    });
    const projectNames = await Promise.all(
      projects.map(async (project) => {
        const githubRepositoryId = project.githubRepositoryId.toString();
        const name = await resolveProjectName({
          githubRepositoryId,
          actorUserId: event.actorUserId,
        }).catch(() => undefined);
        return name ?? `GitHub repository ${githubRepositoryId}`;
      }),
    );
    return {
      deliveries: [
        {
          recipient: { userId: membership.userId, email: email as string },
          idempotencyKey: `keys-shared/${event.operationId}/${membership.userId}`,
          email: renderKeysSharedEmail({
            teamName: membership.team.name,
            projectNames,
            workspaceUrl: webUrl("/workspace", { team: event.teamId }),
            supportAddress: config.supportAddress,
          }),
        },
      ],
      skipped: [],
    };
  };

  const planInvitationAccepted = async (
    event: Extract<EmailEvent, { kind: "invitation_accepted" }>,
  ): Promise<Plan> => {
    const membership = await database.membership.findUnique({
      where: { id: event.membershipId },
      select: {
        userId: true,
        teamId: true,
        team: { select: { name: true } },
        user: { select: { githubSubject: true } },
      },
    });
    if (!membership) return { deliveries: [], skipped: ["no_recipient"] };
    const memberLogin = await database.gitHubLogin
      .findUnique({
        where: { githubSubject: membership.user.githubSubject },
        select: { login: true },
      })
      .then((row) => row?.login ?? null)
      .catch(() => null);
    const administrators = await database.membership.findMany({
      where: {
        teamId: membership.teamId,
        lifecycle: "ACTIVE",
        role: { in: ["OWNER", "ADMIN"] },
        userId: { not: membership.userId },
      },
      select: { userId: true },
      orderBy: { createdAt: "asc" },
    });
    if (administrators.length === 0)
      return { deliveries: [], skipped: ["no_recipient"] };
    const emails = await recipientsFor(
      administrators.map((administrator) => administrator.userId),
    );
    const email = renderInvitationAcceptedEmail({
      teamName: membership.team.name,
      memberName: await displayNameFor(membership.userId),
      memberUserId: membership.userId,
      memberLogin,
      teamId: membership.teamId,
      membersUrl: webUrl("/workspace", {
        team: membership.teamId,
        view: "team",
      }),
      supportAddress: config.supportAddress,
    });
    const deliveries: Delivery[] = [];
    const skipped: ServerDiagnosticEmailReason[] = [];
    for (const { userId } of administrators) {
      const address = emails.get(userId);
      if (!deliverableAddress(address)) {
        skipped.push("no_address");
        continue;
      }
      deliveries.push({
        recipient: { userId, email: address as string },
        idempotencyKey: `invitation-accepted/${event.membershipId}/${userId}`,
        email,
      });
    }
    return { deliveries, skipped };
  };

  const plan = (event: EmailEvent): Promise<Plan> =>
    event.kind === "invitation"
      ? planInvitation(event)
      : event.kind === "keys_shared"
        ? planKeysShared(event)
        : planInvitationAccepted(event);

  // At most one retry, and only for failures a retry can fix.
  const deliver = async (
    kind: ServerDiagnosticEmailKind,
    delivery: Delivery,
  ) => {
    const message: EmailMessage = {
      to: delivery.recipient.email,
      subject: delivery.email.subject,
      text: delivery.email.text,
      html: delivery.email.html,
      idempotencyKey: delivery.idempotencyKey,
    };
    const startedAt = performance.now();
    let reason: EmailFailureReason | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_DELAY_MS);
      try {
        await transport.send(message);
        emit("api.email.sent", kind, {
          outcome: "success",
          durationMs: Math.round(performance.now() - startedAt),
        });
        return;
      } catch (error) {
        reason = failureReason(error);
        if (!RETRYABLE.has(reason)) break;
      }
    }
    emit("api.email.failed", kind, {
      outcome: "failure",
      emailReason: reason ?? "network",
      durationMs: Math.round(performance.now() - startedAt),
    });
  };

  const run = async (event: EmailEvent) => {
    let planned: Plan;
    try {
      planned = await plan(event);
    } catch {
      emit("api.email.failed", event.kind, {
        outcome: "failure",
        emailReason: "lookup_failed",
      });
      return;
    }
    for (const reason of planned.skipped)
      emit("api.email.skipped", event.kind, { emailReason: reason });
    await Promise.all(
      planned.deliveries.map((delivery) => deliver(event.kind, delivery)),
    );
  };

  return Object.freeze({
    notify: (event: EmailEvent) => {
      if (pending.size >= MAX_PENDING_EVENTS) {
        emit("api.email.failed", event.kind, {
          outcome: "failure",
          emailReason: "queue_full",
        });
        return;
      }
      // Start after the current turn so the response is not held up.
      const task = new Promise<void>((resolve) => setTimeout(resolve, 0))
        .then(() => run(event))
        .catch(() => undefined)
        .finally(() => {
          pending.delete(task);
        });
      pending.add(task);
    },
    drain: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  });
};
