import {
  AuditFactRepository,
  type OperationInput,
  OperationRepository,
  type ProtocolObjectInput,
  ProtocolObjectRepository,
  StagedObjectRepository,
} from "./objects";
import {
  PublicationRepository,
  type RevisionPublicationInput,
} from "./publication";
import {
  databaseBytes,
  requireTeamAction,
  StaleEpochError,
  StaleHeadError,
} from "./repository-core";
import { inShortTransaction, type TransactionDatabase } from "./transaction";
import { PERSISTENCE_LIMITS, validateDigest } from "./validation";
export type EpochRotationInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly projectId: string;
  readonly expectedEpoch: bigint;
  readonly newEpoch: bigint;
  readonly transitions: ReadonlyArray<
    Readonly<{
      readonly environmentId: string;
      readonly expectedHeadId: string;
      readonly newHeadId: string;
      readonly protocolObject: ProtocolObjectInput;
      readonly publication: RevisionPublicationInput;
    }>
  >;
  readonly now?: Date;
}>;

export class ProjectEpochRepository {
  private readonly operations = new OperationRepository();
  private readonly protocolObjects = new ProtocolObjectRepository();
  private readonly audit = new AuditFactRepository();
  private readonly publication = new PublicationRepository();
  private readonly stagedObjects = new StagedObjectRepository();

  async rotate(database: TransactionDatabase, input: EpochRotationInput) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const project = await transaction.project.findUnique({
        where: { id: input.projectId },
      });
      if (!project) throw new Error("Project not found");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        project.teamId,
        "ADMINISTER_PROJECT",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      if (project.currentEpoch !== input.expectedEpoch)
        throw new StaleEpochError(project.currentEpoch);
      if (input.newEpoch !== input.expectedEpoch + 1n)
        throw new Error("Project epoch must advance by one");
      const transitions = [...input.transitions].sort((left, right) =>
        left.environmentId.localeCompare(right.environmentId),
      );
      for (const transition of transitions)
        await transaction.$executeRaw`SELECT "id" FROM "environments" WHERE "id" = ${transition.environmentId} AND "projectId" = ${input.projectId} FOR UPDATE`;
      const environments = await transaction.environment.findMany({
        where: { projectId: input.projectId, lifecycle: "ACTIVE" },
        select: { id: true, currentHeadId: true },
        orderBy: { id: "asc" },
      });
      if (
        environments.length !== transitions.length ||
        environments.some(
          (environment, index) =>
            environment.id !== transitions[index]?.environmentId ||
            environment.currentHeadId !== transitions[index]?.expectedHeadId,
        )
      )
        throw new StaleHeadError(null);
      const now = input.now ?? new Date();
      for (const transition of transitions) {
        if (
          transition.protocolObject.kind !== 12 ||
          transition.publication.operation.actorUserId !==
            input.operation.actorUserId ||
          transition.publication.operation.actorDeviceId !==
            input.operation.actorDeviceId ||
          transition.publication.environmentId !== transition.environmentId ||
          transition.publication.expectedHeadId !== transition.expectedHeadId ||
          transition.publication.revision.mutation !== "EPOCH_TRANSITION" ||
          transition.publication.revision.id !== transition.newHeadId ||
          transition.publication.revision.projectEpoch !== input.newEpoch
        )
          throw new Error("Project epoch transition publication is incomplete");
        await this.stagedObjects.promote(transaction, {
          operationId: operation.operation.id,
          actorDeviceId: input.operation.actorDeviceId,
          now,
          objects: [
            {
              objectId: transition.protocolObject.id,
              canonicalBytes: transition.protocolObject.canonicalBytes,
              digest: transition.protocolObject.digest,
            },
          ],
        });
        await this.publication.publishRevisionInTransaction(
          transaction,
          transition.publication,
        );
        const protocolObject = await this.protocolObjects.create(
          transaction,
          transition.protocolObject,
        );
        await transaction.epochTransitionObject.create({
          data: {
            protocolObjectId: protocolObject.id,
            projectId: input.projectId,
            previousEpoch: input.expectedEpoch,
            newEpoch: input.newEpoch,
            expectedHeadId: transition.expectedHeadId,
            newHeadId: transition.newHeadId,
          },
        });
        await transaction.environment.update({
          where: { id: transition.environmentId },
          data: { currentHeadId: transition.newHeadId },
        });
      }
      await transaction.project.update({
        where: { id: input.projectId },
        data: { currentEpoch: input.newEpoch },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "EPOCH_ROTATED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "PROJECT",
        entityId: input.projectId,
        newLifecycle: `epoch:${input.newEpoch.toString()}`,
      });
      return { operation: operation.operation, projectEpoch: input.newEpoch };
    });
  }
}

export type GrantCreationInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly grant: Readonly<{
    readonly protocolObject: ProtocolObjectInput;
    readonly projectId: string;
    readonly teamId: string;
    readonly membershipId?: string;
    readonly senderDeviceId?: string;
    readonly recipientDeviceId: string;
    readonly ownerUserId?: string;
    readonly keyKind:
      | "PROJECT_EPOCH"
      | "USER_DEFINED_VALUE"
      | "USER_TRUST_BUNDLE";
    readonly grantKind:
      | "CURRENT_PROJECT_EPOCH"
      | "HISTORICAL_PROJECT_EPOCH"
      | "CURRENT_USER_VALUE_GENERATION"
      | "HISTORICAL_USER_VALUE_GENERATION"
      | "DEVICE_TRUST_PROVISIONING";
    readonly laneScope?:
      | "ENVIRONMENT_DEFINITION"
      | "VARIABLE_DEFINITION"
      | "SHARED_VALUE"
      | "USER_DEFINED_VALUE";
    readonly projectEpoch?: bigint;
    readonly valueGeneration?: bigint;
    readonly plaintextLength: number;
    readonly ciphertextLength: number;
    readonly ciphertextHash: Uint8Array;
    readonly recipientDeviceIds: ReadonlyArray<string>;
  }>;
  readonly now?: Date;
}>;

export class GrantRepository {
  private readonly operations = new OperationRepository();
  private readonly protocolObjects = new ProtocolObjectRepository();
  private readonly stagedObjects = new StagedObjectRepository();

  async create(database: TransactionDatabase, input: GrantCreationInput) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.grant.projectId} FOR UPDATE`;
      const project = await transaction.project.findUnique({
        where: { id: input.grant.projectId },
      });
      if (!project || project.teamId !== input.grant.teamId)
        throw new Error("Project not found");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.grant.teamId,
        "ADMINISTER_PROJECT",
      );
      const recipientDeviceIds = [...input.grant.recipientDeviceIds].sort();
      if (
        recipientDeviceIds.length === 0 ||
        !recipientDeviceIds.includes(input.grant.recipientDeviceId) ||
        recipientDeviceIds.some(
          (deviceId, index) =>
            index > 0 && deviceId === recipientDeviceIds[index - 1],
        )
      )
        throw new Error("grant recipient set is invalid");
      for (const recipientDeviceId of recipientDeviceIds) {
        const recipient = await transaction.device.findFirst({
          where: { id: recipientDeviceId, lifecycle: "ACTIVE" },
        });
        if (!recipient) throw new Error("grant recipient device is not active");
      }
      if (input.grant.membershipId) {
        const membership = await transaction.membership.findUnique({
          where: { id: input.grant.membershipId },
        });
        if (
          !membership ||
          membership.teamId !== input.grant.teamId ||
          membership.lifecycle !== "PENDING_KEY_GRANT"
        )
          throw new Error("grant membership is not pending key grants");
      }
      if (
        input.grant.plaintextLength > PERSISTENCE_LIMITS.maxGrantPlaintextBytes
      )
        throw new Error("grant plaintext exceeds persistence limit");
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      await this.stagedObjects.promote(transaction, {
        operationId: operation.operation.id,
        actorDeviceId: input.operation.actorDeviceId,
        now,
        objects: [
          {
            objectId: input.grant.protocolObject.id,
            canonicalBytes: input.grant.protocolObject.canonicalBytes,
            digest: input.grant.protocolObject.digest,
          },
        ],
      });
      const protocolObject = await this.protocolObjects.create(
        transaction,
        input.grant.protocolObject,
      );
      const grant = await transaction.grantObject.create({
        data: {
          protocolObjectId: protocolObject.id,
          projectId: input.grant.projectId,
          teamId: input.grant.teamId,
          ...(input.grant.membershipId
            ? { membershipId: input.grant.membershipId }
            : {}),
          ...(input.grant.senderDeviceId
            ? { senderDeviceId: input.grant.senderDeviceId }
            : {}),
          recipientDeviceId: input.grant.recipientDeviceId,
          ...(input.grant.ownerUserId
            ? { ownerUserId: input.grant.ownerUserId }
            : {}),
          keyKind: input.grant.keyKind,
          grantKind: input.grant.grantKind,
          ...(input.grant.laneScope
            ? { laneScope: input.grant.laneScope }
            : {}),
          ...(input.grant.projectEpoch !== undefined
            ? { projectEpoch: input.grant.projectEpoch }
            : {}),
          ...(input.grant.valueGeneration !== undefined
            ? { valueGeneration: input.grant.valueGeneration }
            : {}),
          plaintextLength: input.grant.plaintextLength,
          ciphertextLength: input.grant.ciphertextLength,
          ciphertextHash: databaseBytes(
            validateDigest(input.grant.ciphertextHash, "grant ciphertext hash"),
          ),
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await transaction.auditEvent.create({
        data: {
          operationId: operation.operation.id,
          kind: "GRANT_CREATED",
          actorUserId: input.operation.actorUserId,
          actorDeviceId: input.operation.actorDeviceId,
          entityKind: "PROTOCOL_OBJECT",
          entityId: protocolObject.id,
          outcomeObjectId: protocolObject.id,
        },
      });
      return { operation: operation.operation, grant };
    });
  }
}
