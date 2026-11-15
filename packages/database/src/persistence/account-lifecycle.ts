import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { endMembership } from "./administration-repository";
import {
  AuditFactRepository,
  type OperationInput,
  OperationRepository,
} from "./objects";
import {
  OwnerTransferRequiredError,
  type PersistenceClient,
  requireTeamAction,
  TeamNotActiveError,
} from "./repository-core";
import {
  type ExpiryBatchOptions,
  runExpiryBatches,
  type TransactionDatabase,
} from "./transaction";

/** How long a deleted Team's ciphertext is kept before purge (ADR 0019). */
export const TEAM_PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

// Deleting an account or purging a Team touches many rows; still short, but
// longer than the default ten seconds.
const LIFECYCLE_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 60_000,
});

const inLifecycleTransaction = <T>(
  database: TransactionDatabase,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => database.$transaction(callback, LIFECYCLE_TRANSACTION_OPTIONS);

// Lets this transaction delete append-only rows (see the
// dotrelay_reject_immutable_row trigger). Transaction-local.
const allowPurge = (transaction: PersistenceClient) =>
  transaction.$executeRaw`SELECT set_config('dotrelay.purge', 'on', true)`;

export class TeamDeletionConfirmationError extends Error {
  constructor() {
    super("Team name confirmation does not match");
    this.name = "TeamDeletionConfirmationError";
  }
}

export class AccountDeletionConfirmationError extends Error {
  constructor() {
    super("Account deletion confirmation does not match");
    this.name = "AccountDeletionConfirmationError";
  }
}

export class AccountDeletedError extends Error {
  constructor() {
    super("the account is deleted");
    this.name = "AccountDeletedError";
  }
}

/**
 * Soft-deletes a Team inside the caller's transaction: every Membership
 * ends, pending invitations are revoked, and the Team is ARCHIVED with
 * deletedAt set. No rotation is owed; nobody can read the Team afterwards.
 */
const softDeleteTeam = async (
  transaction: PersistenceClient,
  input: Readonly<{
    readonly teamId: string;
    readonly operation: OperationInput;
    readonly now: Date;
  }>,
) => {
  const memberships = await transaction.membership.findMany({
    where: { teamId: input.teamId, lifecycle: { not: "REMOVED" } },
    select: { id: true, teamId: true, lifecycle: true },
    orderBy: { id: "asc" },
  });
  for (const membership of memberships)
    await endMembership(transaction, {
      membership,
      operation: input.operation,
      now: input.now,
      owesRotation: false,
    });
  await transaction.membershipInvitation.updateMany({
    where: {
      teamId: input.teamId,
      acceptedAt: null,
      revokedAt: null,
      declinedAt: null,
    },
    data: { revokedAt: input.now },
  });
  await transaction.team.update({
    where: { id: input.teamId },
    data: {
      lifecycle: "ARCHIVED",
      archivedAt: input.now,
      deletedAt: input.now,
    },
  });
  await new AuditFactRepository().append(transaction, {
    operationId: input.operation.id,
    kind: "TEAM_DELETED",
    actorUserId: input.operation.actorUserId,
    ...(input.operation.actorDeviceId
      ? { actorDeviceId: input.operation.actorDeviceId }
      : {}),
    entityKind: "TEAM",
    entityId: input.teamId,
    priorLifecycle: "ACTIVE",
    newLifecycle: "DELETED",
  });
};

/**
 * Hard-deletes one soft-deleted Team and the encrypted data of its
 * Projects. Operations and Audit Facts stay; they hold only opaque ids.
 */
const purgeTeam = async (transaction: PersistenceClient, teamId: string) => {
  await allowPurge(transaction);
  await transaction.$executeRaw`
    CREATE TEMP TABLE IF NOT EXISTS "purge_protocol_objects" ("id" UUID PRIMARY KEY)
    ON COMMIT DROP`;
  const project = `SELECT "id" FROM "projects" WHERE "teamId" = $1::uuid`;
  const environment = `SELECT "id" FROM "environments" WHERE "projectId" IN (${project})`;
  const membership = `SELECT "id" FROM "memberships" WHERE "teamId" = $1::uuid`;
  const projections: readonly string[] = [
    `SELECT "protocolObjectId" FROM "lane_commitment_objects" WHERE "projectId" IN (${project})`,
    `SELECT "protocolObjectId" FROM "manifest_descriptors" WHERE "projectId" IN (${project})`,
    `SELECT "protocolObjectId" FROM "revisions" WHERE "environmentId" IN (${environment})`,
    `SELECT "protocolObjectId" FROM "lane_objects" WHERE "projectId" IN (${project})`,
    `SELECT "protocolObjectId" FROM "grant_objects" WHERE "teamId" = $1::uuid OR "projectId" IN (${project})`,
    `SELECT "protocolObjectId" FROM "epoch_transition_objects" WHERE "projectId" IN (${project})`,
    `SELECT "protocolObjectId" FROM "project_epoch_key_links" WHERE "projectId" IN (${project})`,
    `SELECT "protocolObjectId" FROM "account_key_envelope_objects" WHERE "projectId" IN (${project})`,
    `SELECT "protocolObjectId" FROM "membership_activation_objects" WHERE "teamId" = $1::uuid`,
    `SELECT "id" FROM "protocol_objects" WHERE "projectId" IN (${project}) OR "environmentId" IN (${environment})`,
  ];
  for (const query of projections)
    await transaction.$executeRawUnsafe(
      `INSERT INTO "purge_protocol_objects" ("id") ${query} ON CONFLICT DO NOTHING`,
      teamId,
    );
  const deletions: readonly string[] = [
    `DELETE FROM "lane_commitment_objects" WHERE "projectId" IN (${project})`,
    `DELETE FROM "revision_lane_commitments" WHERE "revisionId" IN (SELECT "id" FROM "revisions" WHERE "environmentId" IN (${environment}))`,
    `DELETE FROM "manifest_descriptors" WHERE "projectId" IN (${project})`,
    `UPDATE "environments" SET "currentHeadId" = NULL WHERE "projectId" IN (${project})`,
    `DELETE FROM "revisions" WHERE "environmentId" IN (${environment})`,
    `DELETE FROM "lane_objects" WHERE "projectId" IN (${project})`,
    `DELETE FROM "grant_objects" WHERE "teamId" = $1::uuid OR "projectId" IN (${project})`,
    `DELETE FROM "epoch_transition_objects" WHERE "projectId" IN (${project})`,
    `DELETE FROM "project_epoch_key_links" WHERE "projectId" IN (${project})`,
    `DELETE FROM "account_key_envelope_objects" WHERE "projectId" IN (${project})`,
    `DELETE FROM "membership_activation_objects" WHERE "teamId" = $1::uuid`,
    `DELETE FROM "project_rotation_obligations" WHERE "projectId" IN (${project}) OR "membershipId" IN (${membership})`,
    `DELETE FROM "protocol_objects" WHERE "id" IN (SELECT "id" FROM "purge_protocol_objects")`,
    `DELETE FROM "environments" WHERE "projectId" IN (${project})`,
    `DELETE FROM "projects" WHERE "teamId" = $1::uuid`,
    `DELETE FROM "membership_periods" WHERE "membershipId" IN (${membership})`,
    `DELETE FROM "memberships" WHERE "teamId" = $1::uuid`,
    `DELETE FROM "membership_invitations" WHERE "teamId" = $1::uuid`,
    `DELETE FROM "teams" WHERE "id" = $1::uuid AND "deletedAt" IS NOT NULL`,
  ];
  for (const statement of deletions)
    await (statement.includes("$1")
      ? transaction.$executeRawUnsafe(statement, teamId)
      : transaction.$executeRawUnsafe(statement));
};

export class TeamLifecycleRepository {
  private readonly operations = new OperationRepository();

  /** An owner deletes the Team (ADR 0019); `confirmName` must match. */
  async deleteTeam(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly teamId: string;
      readonly confirmName: string;
      readonly now?: Date;
    }>,
  ) {
    return inLifecycleTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId}::uuid FOR UPDATE`;
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        "DELETE_TEAM",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const team = await transaction.team.findUnique({
        where: { id: input.teamId },
        select: { name: true, lifecycle: true },
      });
      if (team?.lifecycle !== "ACTIVE") throw new TeamNotActiveError();
      if (team.name !== input.confirmName)
        throw new TeamDeletionConfirmationError();
      const now = input.now ?? new Date();
      await softDeleteTeam(transaction, {
        teamId: input.teamId,
        operation: input.operation,
        now,
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      return { operation: operation.operation, deletedAt: now };
    });
  }

  /**
   * Purges Teams deleted at least TEAM_PURGE_AFTER_MS before `now`, one
   * Team per transaction.
   */
  async purgeDeletedTeams(
    database: PrismaClient,
    now: Date,
    options?: ExpiryBatchOptions & { readonly purgeAfterMs?: number },
  ) {
    const deletedBefore = new Date(
      now.getTime() - (options?.purgeAfterMs ?? TEAM_PURGE_AFTER_MS),
    );
    const count = await runExpiryBatches(
      async (batchSize) => {
        const teams = await database.team.findMany({
          where: { deletedAt: { lte: deletedBefore } },
          select: { id: true },
          orderBy: { deletedAt: "asc" },
          take: batchSize,
        });
        for (const team of teams)
          await inLifecycleTransaction(database, (transaction) =>
            purgeTeam(transaction, team.id),
          );
        return { scanned: teams.length, affected: teams.length };
      },
      { batchSize: 10, ...options },
    );
    return { count };
  }
}

export type AccountDeletionPlan = Readonly<{
  /** Teams where the User is the last active owner and others remain. */
  readonly blockingTeams: readonly Readonly<{
    readonly teamId: string;
    readonly name: string;
  }>[];
  /** Teams where the User is the only Member; deleted with the account. */
  readonly teamsDeleted: readonly Readonly<{
    readonly teamId: string;
    readonly name: string;
  }>[];
  /** Teams the User simply leaves. */
  readonly teamsLeft: readonly Readonly<{
    readonly teamId: string;
    readonly name: string;
  }>[];
}>;

const loadDeletionPlan = async (
  database: PersistenceClient,
  userId: string,
): Promise<AccountDeletionPlan> => {
  const memberships = await database.membership.findMany({
    where: {
      userId,
      lifecycle: { not: "REMOVED" },
      team: { lifecycle: "ACTIVE" },
    },
    select: {
      teamId: true,
      role: true,
      lifecycle: true,
      team: {
        select: {
          name: true,
          memberships: {
            where: { userId: { not: userId }, lifecycle: { not: "REMOVED" } },
            select: { role: true, lifecycle: true },
          },
        },
      },
    },
    orderBy: { teamId: "asc" },
  });
  const blockingTeams: { teamId: string; name: string }[] = [];
  const teamsDeleted: { teamId: string; name: string }[] = [];
  const teamsLeft: { teamId: string; name: string }[] = [];
  for (const membership of memberships) {
    const entry = { teamId: membership.teamId, name: membership.team.name };
    const others = membership.team.memberships;
    if (others.length === 0) teamsDeleted.push(entry);
    else if (
      membership.role === "OWNER" &&
      membership.lifecycle === "ACTIVE" &&
      !others.some(
        (other) => other.role === "OWNER" && other.lifecycle === "ACTIVE",
      )
    )
      blockingTeams.push(entry);
    else teamsLeft.push(entry);
  }
  return Object.freeze({ blockingTeams, teamsDeleted, teamsLeft });
};

const tombstoneSubject = (userId: string) => `deleted:${userId}`;

// The account data export (ADR 0018). Metadata only: no ciphertext, wrapped
// keys, public keys, tokens, or protocol bytes.
const MAX_EXPORTED_AUDIT_FACTS = 1_000;

export class AccountLifecycleRepository {
  private readonly operations = new OperationRepository();

  async deletionPlan(database: PersistenceClient, userId: string) {
    return loadDeletionPlan(database, userId);
  }

  /**
   * Deletes the User's account (ADR 0018). Credentials, key material and
   * personal data go; public verification material and opaque ids stay.
   * `confirmUserId` must repeat the User's id.
   */
  async deleteAccount(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly confirmUserId: string;
      readonly now?: Date;
    }>,
  ) {
    const userId = input.operation.actorUserId;
    if (input.confirmUserId !== userId)
      throw new AccountDeletionConfirmationError();
    return inLifecycleTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const user = await transaction.user.findUnique({
        where: { id: userId },
        select: { authSubject: true, githubSubject: true, deletedAt: true },
      });
      if (!user || user.deletedAt) throw new AccountDeletedError();
      // Lock every Team the User belongs to, in id order, before deciding.
      const teamIds = (
        await transaction.membership.findMany({
          where: { userId, lifecycle: { not: "REMOVED" } },
          select: { teamId: true },
          orderBy: { teamId: "asc" },
        })
      ).map((membership) => membership.teamId);
      for (const teamId of teamIds)
        await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId}::uuid FOR UPDATE`;
      const plan = await loadDeletionPlan(transaction, userId);
      if (plan.blockingTeams.length > 0) throw new OwnerTransferRequiredError();
      const now = input.now ?? new Date();
      await allowPurge(transaction);

      for (const team of plan.teamsDeleted)
        await softDeleteTeam(transaction, {
          teamId: team.teamId,
          operation: input.operation,
          now,
        });
      const remaining = await transaction.membership.findMany({
        where: { userId, lifecycle: { not: "REMOVED" } },
        select: { id: true, teamId: true, lifecycle: true },
        orderBy: { teamId: "asc" },
      });
      for (const membership of remaining)
        await endMembership(transaction, {
          membership,
          operation: input.operation,
          now,
        });

      // Unaccepted invitations addressed to the User.
      await transaction.membershipInvitation.deleteMany({
        where: {
          providerSubject: user.githubSubject,
          acceptedAt: null,
          membership: null,
        },
      });

      const deviceIds = (
        await transaction.device.findMany({
          where: { userId },
          select: { id: true },
        })
      ).map((device) => device.id);
      await transaction.device.updateMany({
        where: { userId, lifecycle: { not: "REVOKED" } },
        data: { lifecycle: "REVOKED", revokedAt: now },
      });
      await transaction.device.updateMany({
        where: { userId },
        data: {
          displayName: null,
          nameOverridden: false,
          clientKind: null,
          osName: null,
          clientSummary: null,
        },
      });
      await transaction.stagedObject.deleteMany({
        where: { actorDeviceId: { in: deviceIds }, committedAt: null },
      });
      await transaction.$executeRaw`
        DELETE FROM "device_enrollments" enrollment
        WHERE enrollment."userId" = ${userId}::uuid
          AND enrollment."completedAt" IS NULL
          AND enrollment."approverDeviceId" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "enrollment_objects" object
            WHERE object."enrollmentId" = enrollment."id")
          AND NOT EXISTS (
            SELECT 1 FROM "enrollment_approval_objects" approval
            WHERE approval."enrollmentId" = enrollment."id")`;

      // Key material: wrappers, envelopes, transfers, and every grant sealed
      // to the User's Devices or owned by the User, with their objects.
      await transaction.$executeRaw`
        CREATE TEMP TABLE IF NOT EXISTS "purge_protocol_objects" ("id" UUID PRIMARY KEY)
        ON COMMIT DROP`;
      await transaction.$executeRaw`
        INSERT INTO "purge_protocol_objects" ("id")
        SELECT "protocolObjectId" FROM "account_key_wrapper_objects" WHERE "userId" = ${userId}::uuid
        UNION SELECT "protocolObjectId" FROM "account_key_envelope_objects"
          WHERE "userId" = ${userId}::uuid OR "ownerUserId" = ${userId}::uuid
        UNION SELECT "protocolObjectId" FROM "account_key_transfer_objects" WHERE "userId" = ${userId}::uuid
        UNION SELECT "protocolObjectId" FROM "grant_objects"
          WHERE "ownerUserId" = ${userId}::uuid
            OR "recipientDeviceId" IN (SELECT "id" FROM "devices" WHERE "userId" = ${userId}::uuid)
        ON CONFLICT DO NOTHING`;
      await transaction.$executeRaw`DELETE FROM "account_key_wrapper_objects" WHERE "userId" = ${userId}::uuid`;
      await transaction.$executeRaw`
        DELETE FROM "account_key_envelope_objects"
        WHERE "userId" = ${userId}::uuid OR "ownerUserId" = ${userId}::uuid`;
      await transaction.$executeRaw`DELETE FROM "account_key_transfer_objects" WHERE "userId" = ${userId}::uuid`;
      await transaction.$executeRaw`
        DELETE FROM "grant_objects"
        WHERE "ownerUserId" = ${userId}::uuid
          OR "recipientDeviceId" IN (SELECT "id" FROM "devices" WHERE "userId" = ${userId}::uuid)`;
      await transaction.$executeRaw`
        DELETE FROM "protocol_objects"
        WHERE "id" IN (SELECT "id" FROM "purge_protocol_objects")`;
      await transaction.$executeRaw`TRUNCATE "purge_protocol_objects"`;

      await transaction.user.update({
        where: { id: userId },
        data: {
          authSubject: tombstoneSubject(userId),
          githubSubject: tombstoneSubject(userId),
          deletedAt: now,
        },
      });
      // Sessions, linked GitHub accounts (and their tokens), and device
      // codes cascade from the Better Auth user.
      await transaction.authUser.deleteMany({
        where: { id: user.authSubject },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await new AuditFactRepository().append(transaction, {
        operationId: operation.operation.id,
        kind: "ACCOUNT_DELETED",
        actorUserId: userId,
        entityKind: "USER",
        entityId: userId,
        priorLifecycle: "ACTIVE",
        newLifecycle: "DELETED",
      });
      return {
        operation: operation.operation,
        deletedAt: now,
        teamsDeleted: plan.teamsDeleted,
        teamsLeft: plan.teamsLeft,
      };
    });
  }

  /** The account metadata the service holds about the User (ADR 0018). */
  async exportAccount(database: PersistenceClient, userId: string) {
    const user = await database.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        serverProfileId: true,
        authSubject: true,
        githubSubject: true,
        createdAt: true,
        deletedAt: true,
      },
    });
    if (!user || user.deletedAt) throw new AccountDeletedError();
    const [
      authUser,
      githubAccounts,
      sessions,
      memberships,
      invitations,
      devices,
      wrappers,
      projects,
      revisionStats,
      auditFacts,
    ] = await Promise.all([
      database.authUser.findUnique({
        where: { id: user.authSubject },
        select: {
          name: true,
          email: true,
          emailVerified: true,
          image: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      database.authAccount.findMany({
        where: { userId: user.authSubject },
        select: {
          providerId: true,
          accountId: true,
          scope: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      database.authSession.findMany({
        where: { userId: user.authSubject },
        select: {
          createdAt: true,
          updatedAt: true,
          expiresAt: true,
          ipAddress: true,
          userAgent: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      database.membership.findMany({
        where: { userId },
        select: {
          id: true,
          teamId: true,
          role: true,
          lifecycle: true,
          createdAt: true,
          activatedAt: true,
          removedAt: true,
          team: { select: { name: true, deletedAt: true } },
          periods: {
            select: { activatedAt: true, removedAt: true },
            orderBy: { activatedAt: "asc" },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      database.membershipInvitation.findMany({
        where: {
          OR: [
            { providerSubject: user.githubSubject },
            { acceptedByUserId: userId },
          ],
        },
        select: {
          id: true,
          teamId: true,
          createdAt: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          declinedAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      database.device.findMany({
        where: { userId },
        select: {
          id: true,
          lifecycle: true,
          displayName: true,
          clientKind: true,
          osName: true,
          clientSummary: true,
          createdAt: true,
          activatedAt: true,
          revokedAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      database.accountKeyWrapperObject.findMany({
        where: { userId },
        select: { wrapperType: true, createdAt: true, retiredAt: true },
        orderBy: { createdAt: "asc" },
      }),
      database.project.findMany({
        where: { createdByUserId: userId },
        select: {
          id: true,
          teamId: true,
          githubRepositoryId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      database.revision.aggregate({
        where: { authorUserId: userId },
        _count: { _all: true },
        _min: { acceptedAt: true },
        _max: { acceptedAt: true },
      }),
      database.auditEvent.findMany({
        where: { actorUserId: userId },
        select: {
          kind: true,
          entityKind: true,
          entityId: true,
          receiptAt: true,
        },
        orderBy: { receiptAt: "desc" },
        take: MAX_EXPORTED_AUDIT_FACTS,
      }),
    ]);
    const iso = (value: Date | null) => value?.toISOString() ?? null;
    return {
      format: "dotrelay-account-export-v1",
      user: {
        id: user.id,
        serverProfileId: user.serverProfileId,
        githubUserId: user.githubSubject,
        createdAt: user.createdAt.toISOString(),
      },
      profile: authUser
        ? {
            name: authUser.name,
            email: authUser.email,
            emailVerified: authUser.emailVerified,
            image: authUser.image,
            createdAt: authUser.createdAt.toISOString(),
            updatedAt: authUser.updatedAt.toISOString(),
          }
        : null,
      linkedAccounts: githubAccounts.map((account) => ({
        provider: account.providerId,
        accountId: account.accountId,
        scope: account.scope,
        createdAt: account.createdAt.toISOString(),
        updatedAt: account.updatedAt.toISOString(),
      })),
      sessions: sessions.map((session) => ({
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      })),
      memberships: memberships.map((membership) => ({
        membershipId: membership.id,
        teamId: membership.teamId,
        teamName: membership.team.name,
        teamDeletedAt: iso(membership.team.deletedAt),
        role: membership.role,
        lifecycle: membership.lifecycle,
        createdAt: membership.createdAt.toISOString(),
        activatedAt: iso(membership.activatedAt),
        removedAt: iso(membership.removedAt),
        earlierPeriods: membership.periods.map((period) => ({
          activatedAt: period.activatedAt.toISOString(),
          removedAt: period.removedAt.toISOString(),
        })),
      })),
      invitations: invitations.map((invitation) => ({
        invitationId: invitation.id,
        teamId: invitation.teamId,
        createdAt: invitation.createdAt.toISOString(),
        expiresAt: invitation.expiresAt.toISOString(),
        acceptedAt: iso(invitation.acceptedAt),
        revokedAt: iso(invitation.revokedAt),
        declinedAt: iso(invitation.declinedAt),
      })),
      devices: devices.map((device) => ({
        deviceId: device.id,
        lifecycle: device.lifecycle,
        displayName: device.displayName,
        clientKind: device.clientKind,
        osName: device.osName,
        clientSummary: device.clientSummary,
        createdAt: device.createdAt.toISOString(),
        activatedAt: iso(device.activatedAt),
        revokedAt: iso(device.revokedAt),
      })),
      accountKeyWrappers: wrappers.map((wrapper) => ({
        type: wrapper.wrapperType,
        createdAt: wrapper.createdAt.toISOString(),
        retiredAt: iso(wrapper.retiredAt),
      })),
      projectsCreated: projects.map((project) => ({
        projectId: project.id,
        teamId: project.teamId,
        githubRepositoryId: project.githubRepositoryId.toString(),
        createdAt: project.createdAt.toISOString(),
      })),
      revisionsAuthored: {
        count: revisionStats._count._all,
        firstAcceptedAt: iso(revisionStats._min.acceptedAt),
        lastAcceptedAt: iso(revisionStats._max.acceptedAt),
      },
      auditFacts: auditFacts.map((fact) => ({
        kind: fact.kind,
        entityKind: fact.entityKind,
        entityId: fact.entityId,
        receiptAt: fact.receiptAt.toISOString(),
      })),
    };
  }
}
