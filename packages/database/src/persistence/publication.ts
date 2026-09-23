import {
  AuditFactRepository,
  type OperationInput,
  OperationRepository,
  type ProtocolObjectInput,
  ProtocolObjectRepository,
  StagedObjectRepository,
} from "./objects";
import {
  databaseBytes,
  GenesisExistsError,
  normalizeEnvironmentLabel,
  OperationConflictError,
  type PersistenceClient,
  requireTeamAction,
  StaleEpochError,
  StaleHeadError,
  sameBytes,
} from "./repository-core";
import { inShortTransaction, type TransactionDatabase } from "./transaction";
import {
  validateDigest,
  validateLaneProjection,
  validateProtocolProjection,
  validateSha384Digest,
} from "./validation";
export type LaneProjectionInput = Readonly<{
  readonly id: string;
  readonly protocolObjectId: string;
  readonly operationId?: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly scope:
    | "ENVIRONMENT_DEFINITION"
    | "VARIABLE_DEFINITION"
    | "SHARED_VALUE"
    | "USER_DEFINED_VALUE";
  readonly ownerUserId?: string;
  readonly originalProviderUserId?: string;
  readonly projectEpoch: bigint;
  readonly valueGeneration?: bigint;
  readonly plaintextLength: number;
  readonly ciphertextLength: number;
  readonly ciphertextHash: Uint8Array;
}>;

export type RevisionPublicationInput = Readonly<{
  readonly operation: Readonly<{
    readonly id: string;
    readonly actorUserId: string;
    readonly actorDeviceId: string;
    readonly kind: "REVISION_PUBLICATION" | "ROLLBACK";
    readonly commandBytes: Uint8Array;
    readonly commandDigest: Uint8Array;
    readonly expiresAt?: Date;
  }>;
  readonly environmentId: string;
  readonly expectedHeadId: string | null;
  readonly revision: Readonly<{
    readonly id: string;
    readonly protocolObjectId: string;
    readonly parentHash?: Uint8Array;
    readonly projectEpoch: bigint;
    readonly mutation:
      | "GENESIS"
      | "MANIFEST_UPDATE"
      | "ROLLBACK"
      | "EPOCH_TRANSITION"
      | "USER_KEY_ROTATION";
    readonly authoredAtMs: bigint;
    readonly rollbackTargetId?: string;
  }>;
  readonly revisionObject: ProtocolObjectInput;
  readonly descriptor: Readonly<{
    readonly protocolObject: ProtocolObjectInput;
    readonly schemaVersion: number;
    readonly descriptorHash: Uint8Array;
    readonly laneCount: number;
  }>;
  readonly lanes: ReadonlyArray<
    Readonly<{
      readonly lane: LaneProjectionInput;
      readonly protocolObject: ProtocolObjectInput;
    }>
  >;
  readonly commitments: ReadonlyArray<
    Readonly<{
      readonly ordinal: number;
      readonly laneObjectId: string;
      readonly objectHash: Uint8Array;
      readonly projectEpoch: bigint;
      readonly valueGeneration?: bigint;
      readonly scope: LaneProjectionInput["scope"];
      readonly ownerUserId?: string;
      readonly originalProviderUserId?: string;
      readonly ciphertextLength: number;
    }>
  >;
  readonly audit: Readonly<{
    readonly kind: "REVISION_PUBLISHED" | "ROLLBACK_PUBLISHED";
    readonly entityKind: "ENVIRONMENT";
    readonly entityId: string;
  }>;
}>;

export class PublicationRepository {
  private readonly protocolObjects = new ProtocolObjectRepository();
  private readonly stagedObjects = new StagedObjectRepository();

  async publishRevision(
    database: TransactionDatabase,
    input: RevisionPublicationInput,
  ) {
    return inShortTransaction(database, (transaction) =>
      this.publishRevisionInTransaction(transaction, input),
    );
  }

  async publishRevisionInTransaction(
    transaction: PersistenceClient,
    input: RevisionPublicationInput,
  ) {
    await transaction.$executeRaw`SELECT "id" FROM "environments" WHERE "id" = ${input.environmentId} FOR UPDATE`;
    const existingOperation = await transaction.operation.findUnique({
      where: { id: input.operation.id },
      include: { revision: true },
    });
    if (existingOperation) {
      if (
        existingOperation.actorUserId !== input.operation.actorUserId ||
        existingOperation.actorDeviceId !== input.operation.actorDeviceId ||
        !sameBytes(
          existingOperation.commandDigest,
          input.operation.commandDigest,
        )
      )
        throw new OperationConflictError();
      if (
        existingOperation.status === "COMMITTED" &&
        existingOperation.revision
      )
        return { revision: existingOperation.revision, idempotent: true };
    }

    const environment = await transaction.environment.findUnique({
      where: { id: input.environmentId },
      include: { project: true },
    });
    if (!environment) throw new Error("Environment not found");
    if (
      input.revision.mutation === "GENESIS" &&
      environment.currentHeadId !== null
    )
      throw new GenesisExistsError(environment.currentHeadId);
    if (environment.currentHeadId !== input.expectedHeadId)
      throw new StaleHeadError(environment.currentHeadId);
    if (
      environment.lifecycle !== "ACTIVE" ||
      environment.project.lifecycle !== "ACTIVE"
    )
      throw new Error("Project or Environment is archived");
    if (
      input.revision.mutation !== "EPOCH_TRANSITION" &&
      input.revision.projectEpoch !== environment.project.currentEpoch
    )
      throw new StaleEpochError(environment.project.currentEpoch);
    const parentRevision = input.expectedHeadId
      ? await transaction.revision.findUnique({
          where: { id: input.expectedHeadId },
          include: { protocolObject: true },
        })
      : null;
    if (input.expectedHeadId) {
      if (
        !parentRevision ||
        parentRevision.environmentId !== input.environmentId ||
        !input.revision.parentHash ||
        !sameBytes(
          parentRevision.protocolObject.digest,
          input.revision.parentHash,
        )
      )
        throw new StaleHeadError(environment.currentHeadId);
    } else if (input.revision.parentHash) {
      throw new Error("genesis cannot carry a parent hash");
    }

    const device = await transaction.device.findFirst({
      where: {
        id: input.operation.actorDeviceId,
        userId: input.operation.actorUserId,
        lifecycle: "ACTIVE",
      },
    });
    if (!device) throw new Error("Device is not active");
    const membership = await transaction.membership.findFirst({
      where: {
        teamId: environment.project.teamId,
        userId: input.operation.actorUserId,
        lifecycle: "ACTIVE",
      },
    });
    if (!membership) throw new Error("Membership is not active");

    await validateSha384Digest(
      input.operation.commandBytes,
      input.operation.commandDigest,
      "operation digest",
    );
    validateProtocolProjection(input.revisionObject);
    if (input.revisionObject.id !== input.revision.protocolObjectId)
      throw new Error(
        "Revision protocol object id does not match its projection",
      );
    if (
      input.revisionObject.projectId !== environment.projectId ||
      input.revisionObject.environmentId !== input.environmentId ||
      input.descriptor.protocolObject.projectId !== environment.projectId ||
      input.descriptor.protocolObject.environmentId !== input.environmentId
    )
      throw new Error(
        "publication protocol objects are outside the Environment",
      );
    validateProtocolProjection(input.descriptor.protocolObject);
    if (
      !sameBytes(
        input.descriptor.descriptorHash,
        input.descriptor.protocolObject.digest,
      )
    )
      throw new Error("Manifest descriptor hash does not match its object");
    if (
      input.descriptor.laneCount !== input.lanes.length ||
      input.commitments.length !== input.lanes.length
    )
      throw new Error("Manifest descriptor lane projection is incomplete");
    const laneIds = new Set(input.lanes.map(({ lane }) => lane.id));
    const ordinals = new Set<number>();
    for (const lane of input.lanes) {
      validateLaneProjection(lane.lane);
      if (
        lane.lane.projectId !== environment.projectId ||
        lane.lane.environmentId !== input.environmentId ||
        lane.lane.projectEpoch !== input.revision.projectEpoch ||
        lane.protocolObject.projectId !== environment.projectId ||
        lane.protocolObject.environmentId !== input.environmentId
      )
        throw new Error("lane projection is outside the publication context");
      if (lane.protocolObject.id !== lane.lane.protocolObjectId)
        throw new Error(
          "lane protocol object id does not match its projection",
        );
      validateProtocolProjection(lane.protocolObject);
    }
    for (const commitment of input.commitments) {
      validateDigest(commitment.objectHash, "lane commitment hash");
      if (!laneIds.has(commitment.laneObjectId))
        throw new Error("Manifest commitment references an unknown lane");
      if (ordinals.has(commitment.ordinal))
        throw new Error("Manifest commitment ordinals must be unique");
      ordinals.add(commitment.ordinal);
      const lane = input.lanes.find(
        ({ lane: candidate }) => candidate.id === commitment.laneObjectId,
      );
      if (!lane)
        throw new Error("Manifest commitment references an unknown lane");
      if (
        commitment.projectEpoch !== lane.lane.projectEpoch ||
        commitment.valueGeneration !== lane.lane.valueGeneration ||
        commitment.scope !== lane.lane.scope ||
        commitment.ownerUserId !== lane.lane.ownerUserId ||
        commitment.originalProviderUserId !==
          lane.lane.originalProviderUserId ||
        commitment.ciphertextLength !== lane.lane.ciphertextLength ||
        !sameBytes(commitment.objectHash, lane.protocolObject.digest)
      )
        throw new Error(
          "Manifest commitment does not match its lane projection",
        );
    }
    if ([...ordinals].some((ordinal, index) => ordinal !== index))
      throw new Error("Manifest commitment ordinals must be contiguous");
    if (input.revision.mutation === "ROLLBACK") {
      if (!input.revision.rollbackTargetId)
        throw new Error("rollback must identify its target revision");
      const rollbackTarget = await transaction.revision.findUnique({
        where: { id: input.revision.rollbackTargetId },
        select: { environmentId: true },
      });
      if (
        !rollbackTarget ||
        rollbackTarget.environmentId !== input.environmentId
      )
        throw new Error("rollback target is outside the Environment");
    }

    const operation = existingOperation
      ? existingOperation
      : await transaction.operation.create({
          data: {
            id: input.operation.id,
            actorUserId: input.operation.actorUserId,
            ...(input.operation.actorDeviceId
              ? { actorDeviceId: input.operation.actorDeviceId }
              : {}),
            kind: input.operation.kind,
            commandDigest: databaseBytes(
              validateDigest(input.operation.commandDigest, "operation digest"),
            ),
            ...(input.operation.expiresAt
              ? { expiresAt: input.operation.expiresAt }
              : {}),
          },
        });

    const stagedNow = new Date();
    await this.stagedObjects.promote(transaction, {
      operationId: operation.id,
      actorDeviceId: input.operation.actorDeviceId,
      now: stagedNow,
      objects: [
        {
          objectId: input.revisionObject.id,
          canonicalBytes: input.revisionObject.canonicalBytes,
          digest: input.revisionObject.digest,
        },
        {
          objectId: input.descriptor.protocolObject.id,
          canonicalBytes: input.descriptor.protocolObject.canonicalBytes,
          digest: input.descriptor.protocolObject.digest,
        },
        ...input.lanes.map(({ protocolObject }) => ({
          objectId: protocolObject.id,
          canonicalBytes: protocolObject.canonicalBytes,
          digest: protocolObject.digest,
        })),
      ],
    });

    const revisionObject = await this.protocolObjects.create(
      transaction,
      input.revisionObject,
    );
    const revision = await transaction.revision.create({
      data: {
        id: input.revision.id,
        protocolObjectId: revisionObject.id,
        operationId: operation.id,
        environmentId: input.environmentId,
        parentId: input.expectedHeadId,
        ...(input.revision.parentHash
          ? {
              parentHash: databaseBytes(
                validateDigest(input.revision.parentHash, "parent hash"),
              ),
            }
          : {}),
        authorUserId: input.operation.actorUserId,
        signingDeviceId: device.id,
        projectEpoch: input.revision.projectEpoch,
        mutation: input.revision.mutation,
        authoredAtMs: input.revision.authoredAtMs,
        ...(input.revision.rollbackTargetId
          ? { rollbackTargetId: input.revision.rollbackTargetId }
          : {}),
      },
    });

    for (const laneInput of input.lanes) {
      const protocolObject = await this.protocolObjects.create(
        transaction,
        laneInput.protocolObject,
      );
      await transaction.laneObject.create({
        data: {
          id: laneInput.lane.id,
          protocolObjectId: protocolObject.id,
          operationId: operation.id,
          projectId: laneInput.lane.projectId,
          environmentId: laneInput.lane.environmentId,
          scope: laneInput.lane.scope,
          ...(laneInput.lane.ownerUserId
            ? { ownerUserId: laneInput.lane.ownerUserId }
            : {}),
          ...(laneInput.lane.originalProviderUserId
            ? { originalProviderUserId: laneInput.lane.originalProviderUserId }
            : {}),
          projectEpoch: laneInput.lane.projectEpoch,
          ...(laneInput.lane.valueGeneration !== undefined
            ? { valueGeneration: laneInput.lane.valueGeneration }
            : {}),
          plaintextLength: laneInput.lane.plaintextLength,
          ciphertextLength: laneInput.lane.ciphertextLength,
          ciphertextHash: databaseBytes(
            validateDigest(laneInput.lane.ciphertextHash, "ciphertext hash"),
          ),
        },
      });
    }

    const descriptorObject = await this.protocolObjects.create(
      transaction,
      input.descriptor.protocolObject,
    );
    await transaction.manifestDescriptor.create({
      data: {
        protocolObjectId: descriptorObject.id,
        revisionId: revision.id,
        projectId: environment.projectId,
        environmentId: input.environmentId,
        schemaVersion: input.descriptor.schemaVersion,
        descriptorHash: databaseBytes(
          validateDigest(
            input.descriptor.descriptorHash,
            "Manifest descriptor hash",
          ),
        ),
        laneCount: input.descriptor.laneCount,
      },
    });

    for (const commitment of input.commitments) {
      await transaction.revisionLaneCommitment.create({
        data: {
          revisionId: revision.id,
          ordinal: commitment.ordinal,
          laneObjectId: commitment.laneObjectId,
          objectHash: databaseBytes(
            validateDigest(commitment.objectHash, "lane commitment hash"),
          ),
          projectEpoch: commitment.projectEpoch,
          ...(commitment.valueGeneration !== undefined
            ? { valueGeneration: commitment.valueGeneration }
            : {}),
          scope: commitment.scope,
          ...(commitment.ownerUserId
            ? { ownerUserId: commitment.ownerUserId }
            : {}),
          ...(commitment.originalProviderUserId
            ? { originalProviderUserId: commitment.originalProviderUserId }
            : {}),
          ciphertextLength: commitment.ciphertextLength,
        },
      });
    }

    await transaction.environment.update({
      where: { id: input.environmentId },
      data: { currentHeadId: revision.id },
    });
    await transaction.operation.update({
      where: { id: operation.id },
      data: { status: "COMMITTED", committedAt: new Date() },
    });
    await transaction.auditEvent.create({
      data: {
        operationId: operation.id,
        kind: input.audit.kind,
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: input.audit.entityKind,
        entityId: input.audit.entityId,
        outcomeObjectId: revisionObject.id,
        outcomeRevisionId: revision.id,
      },
    });
    return { revision, idempotent: false };
  }
}

export type EnvironmentGenesisInput = Readonly<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly createdByUserId: string;
  readonly label?: string;
  readonly publication: RevisionPublicationInput;
}>;

export type EnvironmentCreationInput = Readonly<{
  readonly environmentId?: string;
  readonly projectId: string;
  readonly createdByUserId: string;
  readonly label?: string;
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly now?: Date;
}>;

export class EnvironmentRepository {
  private readonly publication = new PublicationRepository();
  private readonly operations = new OperationRepository();
  private readonly audit = new AuditFactRepository();

  async create(database: TransactionDatabase, input: EnvironmentCreationInput) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const project = await transaction.project.findUnique({
        where: { id: input.projectId },
        select: { lifecycle: true, teamId: true },
      });
      if (project?.lifecycle !== "ACTIVE")
        throw new Error("Project is not active");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        project.teamId,
        "ADMINISTER_ENVIRONMENT",
      );
      if (input.createdByUserId !== input.operation.actorUserId)
        throw new Error("Environment creator must be the operation actor");
      const label = normalizeEnvironmentLabel(input.label);
      const existingEnvironment = await transaction.environment.findFirst({
        where: {
          projectId: input.projectId,
          label,
          lifecycle: "ACTIVE",
        },
      });
      if (existingEnvironment)
        return {
          existing: true as const,
          environment: existingEnvironment,
        };
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      const environment = await transaction.environment.create({
        data: {
          id: input.environmentId ?? crypto.randomUUID(),
          projectId: input.projectId,
          createdByUserId: input.createdByUserId,
          label,
          createdAt: now,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
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
      return { operation: operation.operation, environment };
    });
  }

  async createWithGenesis(
    database: TransactionDatabase,
    input: EnvironmentGenesisInput,
  ) {
    if (input.publication.expectedHeadId !== null)
      throw new Error("genesis must start with an empty Environment head");
    if (input.publication.revision.mutation !== "GENESIS")
      throw new Error("genesis must use the GENESIS mutation");
    if (
      input.createdByUserId !== input.publication.operation.actorUserId ||
      input.environmentId !== input.publication.environmentId ||
      input.projectId !== input.publication.revisionObject.projectId
    )
      throw new Error("Environment genesis context does not match its actor");
    return inShortTransaction(database, async (transaction) => {
      const project = await transaction.project.findUnique({
        where: { id: input.projectId },
        select: { lifecycle: true, teamId: true },
      });
      if (project?.lifecycle !== "ACTIVE")
        throw new Error("Project is not active");
      await requireTeamAction(
        transaction,
        input.publication.operation.actorUserId,
        input.publication.operation.actorDeviceId,
        project.teamId,
        "ADMINISTER_ENVIRONMENT",
      );
      await transaction.environment.create({
        data: {
          id: input.environmentId,
          projectId: input.projectId,
          createdByUserId: input.createdByUserId,
          label:
            input.label ??
            `env-${input.environmentId.replaceAll("-", "").slice(0, 8)}`,
        },
      });
      return this.publication.publishRevisionInTransaction(
        transaction,
        input.publication,
      );
    });
  }
}
