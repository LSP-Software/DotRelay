import {
  AuditFactRepository,
  type OperationInput,
  OperationRepository,
} from "./objects";
import {
  DEFAULT_ENVIRONMENT_LABEL,
  managedRoleAction,
  requireActiveDevice,
  requireTeamAction,
} from "./repository-core";
import { inShortTransaction, type TransactionDatabase } from "./transaction";
export type TeamCreationInput = Readonly<{
  readonly teamId?: string;
  readonly serverProfileId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly now?: Date;
}>;

export class AdministrationRepository {
  private readonly operations = new OperationRepository();
  private readonly audit = new AuditFactRepository();

  async createTeamWithOwner(
    database: TransactionDatabase,
    input: TeamCreationInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      const now = input.now ?? new Date();
      await requireActiveDevice(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
      );
      if (input.operation.actorUserId !== input.ownerUserId)
        throw new Error("Team owner must be the operation actor");
      const owner = await transaction.user.findUnique({
        where: { id: input.ownerUserId },
        select: { serverProfileId: true },
      });
      if (!owner || owner.serverProfileId !== input.serverProfileId)
        throw new Error("Team owner belongs to another Server Profile");
      const existingTeam = await transaction.team.findFirst({
        where: {
          serverProfileId: input.serverProfileId,
          name: input.name,
          lifecycle: "ACTIVE",
          memberships: {
            some: {
              userId: input.ownerUserId,
              role: "OWNER",
              lifecycle: "ACTIVE",
            },
          },
        },
      });
      if (existingTeam)
        return {
          existing: true as const,
          team: existingTeam,
        };
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const team = await transaction.team.create({
        data: {
          id: input.teamId ?? crypto.randomUUID(),
          serverProfileId: input.serverProfileId,
          name: input.name,
          createdAt: now,
        },
      });
      const membership = await transaction.membership.create({
        data: {
          id: crypto.randomUUID(),
          teamId: team.id,
          userId: input.ownerUserId,
          role: "OWNER",
          lifecycle: "ACTIVE",
          createdAt: now,
          activatedAt: now,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "TEAM_CREATED",
        actorUserId: input.operation.actorUserId,
        actorDeviceId: input.operation.actorDeviceId,
        entityKind: "TEAM",
        entityId: team.id,
        newLifecycle: "ACTIVE",
      });
      return { operation: operation.operation, team, membership };
    });
  }

  async archiveProject(
    database: TransactionDatabase,
    input: Readonly<{
      projectId: string;
      operation: OperationInput;
      now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const lockedProject = await transaction.project.findUnique({
        where: { id: input.projectId },
      });
      if (!lockedProject) throw new Error("Project not found");
      if (lockedProject.lifecycle !== "ACTIVE")
        throw new Error("Project is not active");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        lockedProject.teamId,
        "ADMINISTER_PROJECT",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const project = await transaction.project.update({
        where: { id: input.projectId },
        data: { lifecycle: "ARCHIVED", archivedAt: input.now ?? new Date() },
      });
      const now = input.now ?? new Date();
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "PROJECT_ARCHIVED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "PROJECT",
        entityId: project.id,
        priorLifecycle: "ACTIVE",
        newLifecycle: "ARCHIVED",
      });
      return { operation: operation.operation, project };
    });
  }

  async restoreProject(
    database: TransactionDatabase,
    input: Readonly<{
      projectId: string;
      operation: OperationInput;
      now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const lockedProject = await transaction.project.findUnique({
        where: { id: input.projectId },
      });
      if (!lockedProject) throw new Error("Project not found");
      if (lockedProject.lifecycle !== "ARCHIVED")
        throw new Error("Project is not archived");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        lockedProject.teamId,
        "ADMINISTER_PROJECT",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const project = await transaction.project.update({
        where: { id: input.projectId },
        data: { lifecycle: "ACTIVE", archivedAt: null },
      });
      const now = input.now ?? new Date();
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "PROJECT_RESTORED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "PROJECT",
        entityId: project.id,
        priorLifecycle: "ARCHIVED",
        newLifecycle: "ACTIVE",
      });
      return { operation: operation.operation, project };
    });
  }

  async archiveEnvironment(
    database: TransactionDatabase,
    input: Readonly<{
      environmentId: string;
      operation: OperationInput;
      now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "environments" WHERE "id" = ${input.environmentId} FOR UPDATE`;
      const lockedEnvironment = await transaction.environment.findUnique({
        where: { id: input.environmentId },
        include: { project: true },
      });
      if (!lockedEnvironment) throw new Error("Environment not found");
      if (lockedEnvironment.lifecycle !== "ACTIVE")
        throw new Error("Environment is not active");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        lockedEnvironment.project.teamId,
        "ADMINISTER_ENVIRONMENT",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const environment = await transaction.environment.update({
        where: { id: input.environmentId },
        data: {
          lifecycle: "ARCHIVED",
          archivedAt: input.now ?? new Date(),
        },
      });
      const now = input.now ?? new Date();
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "ENVIRONMENT_ARCHIVED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "ENVIRONMENT",
        entityId: environment.id,
        priorLifecycle: "ACTIVE",
        newLifecycle: "ARCHIVED",
      });
      return { operation: operation.operation, environment };
    });
  }

  async restoreEnvironment(
    database: TransactionDatabase,
    input: Readonly<{
      environmentId: string;
      operation: OperationInput;
      now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "environments" WHERE "id" = ${input.environmentId} FOR UPDATE`;
      const lockedEnvironment = await transaction.environment.findUnique({
        where: { id: input.environmentId },
        include: { project: true },
      });
      if (!lockedEnvironment) throw new Error("Environment not found");
      if (lockedEnvironment.lifecycle !== "ARCHIVED")
        throw new Error("Environment is not archived");
      if (lockedEnvironment.project.lifecycle !== "ACTIVE")
        throw new Error("Project is archived");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        lockedEnvironment.project.teamId,
        "ADMINISTER_ENVIRONMENT",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const environment = await transaction.environment.update({
        where: { id: input.environmentId },
        data: { lifecycle: "ACTIVE", archivedAt: null },
      });
      const now = input.now ?? new Date();
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "ENVIRONMENT_RESTORED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "ENVIRONMENT",
        entityId: environment.id,
        priorLifecycle: "ARCHIVED",
        newLifecycle: "ACTIVE",
      });
      return { operation: operation.operation, environment };
    });
  }
}

export class MembershipAdministrationRepository {
  private readonly operations = new OperationRepository();
  private readonly audit = new AuditFactRepository();

  async invite(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly teamId: string;
      readonly invitationId?: string;
      readonly providerSubject: string;
      readonly now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId} FOR UPDATE`;
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        "INVITE_MEMBER",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const team = await transaction.team.findUnique({
        where: { id: input.teamId },
        select: { lifecycle: true },
      });
      if (team?.lifecycle !== "ACTIVE") throw new Error("Team is not active");
      if (input.providerSubject.length === 0)
        throw new Error("GitHub provider subject is required");
      const now = input.now ?? new Date();
      const invitation = await transaction.membershipInvitation.create({
        data: {
          id: input.invitationId ?? crypto.randomUUID(),
          teamId: input.teamId,
          providerSubject: input.providerSubject,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000),
          createdAt: now,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "MEMBERSHIP_INVITED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "INVITATION",
        entityId: invitation.id,
      });
      return { operation: operation.operation, invitation };
    });
  }

  async accept(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly invitationId: string;
      readonly userId: string;
      readonly now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "membership_invitations" WHERE "id" = ${input.invitationId} FOR UPDATE`;
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      if (input.operation.actorUserId !== input.userId)
        throw new Error("Membership invitation must be accepted by its User");
      const invitation = await transaction.membershipInvitation.findUnique({
        where: { id: input.invitationId },
      });
      const user = await transaction.user.findUnique({
        where: { id: input.userId },
      });
      if (!invitation || !user) throw new Error("Invitation or User not found");
      if (
        invitation.acceptedAt ||
        invitation.expiresAt <= (input.now ?? new Date())
      )
        throw new Error("Membership invitation is expired or already used");
      if (user.githubSubject !== invitation.providerSubject)
        throw new Error("Membership invitation is addressed to another User");
      const team = await transaction.team.findUnique({
        where: { id: invitation.teamId },
        select: { serverProfileId: true },
      });
      if (!team || team.serverProfileId !== user.serverProfileId)
        throw new Error(
          "Membership invitation belongs to another Server Profile",
        );
      const now = input.now ?? new Date();
      const membership = await transaction.membership.create({
        data: {
          id: crypto.randomUUID(),
          teamId: invitation.teamId,
          userId: user.id,
          invitationId: invitation.id,
          createdAt: now,
        },
      });
      await transaction.membershipInvitation.update({
        where: { id: invitation.id },
        data: { acceptedByUserId: user.id, acceptedAt: now },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "MEMBERSHIP_ACCEPTED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "MEMBERSHIP",
        entityId: membership.id,
        newLifecycle: "PENDING_KEY_GRANT",
      });
      return { operation: operation.operation, membership };
    });
  }

  async changeRole(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly teamId: string;
      readonly membershipId: string;
      readonly role: "OWNER" | "ADMIN" | "MEMBER";
      readonly now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId} FOR UPDATE`;
      const membership = await transaction.membership.findUnique({
        where: { id: input.membershipId },
      });
      if (!membership || membership.teamId !== input.teamId)
        throw new Error("Membership not found");
      if (membership.lifecycle === "REMOVED")
        throw new Error("Membership is removed");
      const managedRole =
        membership.role === "OWNER" || input.role === "OWNER"
          ? "OWNER"
          : membership.role === "ADMIN" || input.role === "ADMIN"
            ? "ADMIN"
            : "MEMBER";
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        managedRoleAction(managedRole),
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const changed = await transaction.membership.update({
        where: { id: membership.id },
        data: { role: input.role },
      });
      const now = input.now ?? new Date();
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "MEMBERSHIP_ROLE_CHANGED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "MEMBERSHIP",
        entityId: membership.id,
        priorLifecycle: membership.role,
        newLifecycle: input.role,
      });
      return { operation: operation.operation, membership: changed };
    });
  }

  async remove(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly teamId: string;
      readonly membershipId: string;
      readonly now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId} FOR UPDATE`;
      const membership = await transaction.membership.findUnique({
        where: { id: input.membershipId },
      });
      if (!membership || membership.teamId !== input.teamId)
        throw new Error("Membership not found");
      if (membership.lifecycle === "REMOVED")
        throw new Error("Membership is already removed");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        managedRoleAction(membership.role),
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      const removed = await transaction.membership.update({
        where: { id: membership.id },
        data: { lifecycle: "REMOVED", removedAt: now },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "MEMBERSHIP_REMOVED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "MEMBERSHIP",
        entityId: membership.id,
        priorLifecycle: membership.lifecycle,
        newLifecycle: "REMOVED",
      });
      return { operation: operation.operation, membership: removed };
    });
  }
}

export type ProjectCreationInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly teamId: string;
  readonly projectId?: string;
  readonly githubRepositoryId: bigint;
  readonly now?: Date;
}>;

export class ProjectRepository {
  private readonly operations = new OperationRepository();
  private readonly audit = new AuditFactRepository();

  async create(database: TransactionDatabase, input: ProjectCreationInput) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId} FOR UPDATE`;
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        "ADMINISTER_PROJECT",
      );
      const team = await transaction.team.findUnique({
        where: { id: input.teamId },
        select: { lifecycle: true },
      });
      if (team?.lifecycle !== "ACTIVE") throw new Error("Team is archived");
      if (input.githubRepositoryId <= 0n)
        throw new Error("GitHub Repository id must be positive");
      const existingProject = await transaction.project.findFirst({
        where: {
          teamId: input.teamId,
          githubRepositoryId: input.githubRepositoryId,
          lifecycle: "ACTIVE",
        },
      });
      if (existingProject) {
        const environment =
          (await transaction.environment.findFirst({
            where: {
              projectId: existingProject.id,
              lifecycle: "ACTIVE",
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })) ??
          (await transaction.environment.create({
            data: {
              id: crypto.randomUUID(),
              projectId: existingProject.id,
              createdByUserId: input.operation.actorUserId,
              label: DEFAULT_ENVIRONMENT_LABEL,
              createdAt: input.now ?? new Date(),
            },
          }));
        return {
          existing: true as const,
          project: existingProject,
          environment,
        };
      }
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      const project = await transaction.project.create({
        data: {
          id: input.projectId ?? crypto.randomUUID(),
          teamId: input.teamId,
          githubRepositoryId: input.githubRepositoryId,
          createdByUserId: input.operation.actorUserId,
          createdAt: now,
        },
      });
      const environment = await transaction.environment.create({
        data: {
          id: crypto.randomUUID(),
          projectId: project.id,
          createdByUserId: input.operation.actorUserId,
          label: DEFAULT_ENVIRONMENT_LABEL,
          createdAt: now,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "PROJECT_CREATED",
        actorUserId: input.operation.actorUserId,
        actorDeviceId: input.operation.actorDeviceId,
        entityKind: "PROJECT",
        entityId: project.id,
        newLifecycle: "ACTIVE",
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "ENVIRONMENT_CREATED",
        actorUserId: input.operation.actorUserId,
        actorDeviceId: input.operation.actorDeviceId,
        entityKind: "ENVIRONMENT",
        entityId: environment.id,
        newLifecycle: "ACTIVE",
      });
      return { operation: operation.operation, project, environment };
    });
  }
}
