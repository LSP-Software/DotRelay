import {
  bytesToUuid,
  canonicalEncode,
  type CborValue,
  parseProtocolObject,
  sha384,
} from "@dotrelay/contracts";
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
  DeviceNotActiveError,
  GenesisExistsError,
  MembershipNotActiveError,
  normalizeEnvironmentLabel,
  OperationConflictError,
  ProjectNotActiveError,
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
type PublicationScope = Readonly<{
  readonly projectId: string;
  readonly environmentId: string;
}>;

// The projections stamp Project and Environment from the route arguments, so
// they cannot prove a blob belongs to the target. The signed canonical bytes
// can: Revisions (kind 16) and Manifest descriptors (kind 15) always carry
// Project (field 13) and Environment (field 14) inside the signature, and
// Ciphertext lane objects (kind 13) carry them when present. Bind those signed
// ids to the Environment the operation actually targets.
const assertSignedPublicationScope = (
  canonicalBytes: Uint8Array,
  scope: PublicationScope,
  required: boolean,
  label: string,
): void => {
  const object = parseProtocolObject(canonicalBytes);
  const fields = [
    [13, scope.projectId, "Project"],
    [14, scope.environmentId, "Environment"],
  ] as const;
  for (const [field, expectedId, name] of fields) {
    const value = object.get(field);
    if (value === undefined) {
      if (required)
        throw new Error(`${label} is missing its signed ${name} id`);
      continue;
    }
    if (!(value instanceof Uint8Array) || value.length !== 16)
      throw new Error(`${label} signed ${name} id is not a UUID`);
    if (bytesToUuid(value) !== expectedId)
      throw new Error(
        `${label} names a different ${name} than its publication target`,
      );
  }
};

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
  readonly finalizationDigest?: Uint8Array;
  readonly operation: Readonly<{
    readonly id: string;
    readonly actorUserId: string;
    readonly actorDeviceId: string;
    readonly kind: "REVISION_PUBLICATION" | "ROLLBACK";
    readonly commandBytes: Uint8Array;
    readonly commandDigest: Uint8Array;
    readonly expiresAt?: Date;
  }>;
  // Set by ProjectEpochRepository.rotate: this publication is one transition
  // of a Project epoch rotation, sharing one operation across Environments.
  // The shared operation stays STAGED until rotate() commits it exactly once
  // after every transition published, so an inner publication must not
  // commit it or let a COMMITTED status block the remaining Environments.
  readonly rotationInner?: boolean;
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

const commitmentScopeFromField = (
  scope: number,
): LaneProjectionInput["scope"] | null =>
  scope === 1
    ? "ENVIRONMENT_DEFINITION"
    : scope === 2
      ? "VARIABLE_DEFINITION"
      : scope === 3
        ? "SHARED_VALUE"
        : scope === 4
          ? "USER_DEFINED_VALUE"
          : null;

const commitmentUserId = (value: CborValue | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (!(value instanceof Uint8Array) || value.length !== 16)
    throw new Error("signed revision lane commitment is malformed");
  return bytesToUuid(value);
};

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
    const projectScope = await transaction.environment.findUnique({
      where: { id: input.environmentId },
      select: { projectId: true },
    });
    if (!projectScope) throw new Error("Environment not found");
    await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectScope.projectId} FOR UPDATE`;
    await transaction.$executeRaw`SELECT "id" FROM "environments" WHERE "id" = ${input.environmentId} FOR UPDATE`;
    const existingOperation = await transaction.operation.findUnique({
      where: { id: input.operation.id },
      include: { revisions: true },
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
      // A committed operation's outcome is final. A replay of the revision
      // it already published is idempotent; a different revision is a
      // conflict. Rotation inner publications are the one exception: their
      // shared operation is committed only after every Environment of the
      // rotation has published, so a committed operation can still owe this
      // Environment its revision.
      const existingRevision = existingOperation.revisions.find(
        (revision) => revision.id === input.revision.id,
      );
      if (existingOperation.status === "COMMITTED") {
        if (
          input.finalizationDigest &&
          (!existingOperation.finalizationDigest ||
            !sameBytes(
              existingOperation.finalizationDigest,
              input.finalizationDigest,
            ))
        )
          throw new OperationConflictError();
        if (existingRevision)
          return { revision: existingRevision, idempotent: true };
        if (!input.rotationInner) throw new OperationConflictError();
      }
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
    if (!device) throw new DeviceNotActiveError();
    const membership = await transaction.membership.findFirst({
      where: {
        teamId: environment.project.teamId,
        userId: input.operation.actorUserId,
        lifecycle: "ACTIVE",
      },
    });
    if (!membership) throw new MembershipNotActiveError();

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
    const publicationScope = {
      projectId: environment.projectId,
      environmentId: input.environmentId,
    };
    assertSignedPublicationScope(
      input.revisionObject.canonicalBytes,
      publicationScope,
      true,
      "revision object",
    );
    assertSignedPublicationScope(
      input.descriptor.protocolObject.canonicalBytes,
      publicationScope,
      true,
      "manifest descriptor object",
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
      assertSignedPublicationScope(
        lane.protocolObject.canonicalBytes,
        publicationScope,
        false,
        "lane object",
      );
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
    // Bind the submitted descriptor and lanes to the signed revision: the
    // revision commits to the manifest (field 51 = descriptor bytes, field 52
    // = its hash) and to the lane commitments (field 53), and the descriptor
    // repeats those commitments. The client re-verifies all of this on read,
    // so the write path must reject any pairing the client would reject.
    const revisionFields = parseProtocolObject(
      input.revisionObject.canonicalBytes,
    );
    const manifestDescriptorBytes = revisionFields.get(51);
    const manifestHash = revisionFields.get(52);
    const manifestCommitments = revisionFields.get(53);
    if (
      !(manifestDescriptorBytes instanceof Uint8Array) ||
      !(manifestHash instanceof Uint8Array) ||
      !Array.isArray(manifestCommitments)
    )
      throw new Error("signed revision does not commit to its manifest");
    if (!sameBytes(input.descriptor.descriptorHash, manifestHash))
      throw new Error(
        "submitted descriptor hash differs from the signed revision's manifest",
      );
    if (!sameBytes(await sha384(manifestDescriptorBytes), manifestHash))
      throw new Error(
        "signed revision manifest hash does not match its descriptor bytes",
      );
    if (
      !sameBytes(
        manifestDescriptorBytes,
        input.descriptor.protocolObject.canonicalBytes,
      )
    )
      throw new Error(
        "submitted descriptor differs from the signed revision's manifest",
      );
    if (input.descriptor.laneCount !== manifestCommitments.length)
      throw new Error(
        "signed revision lane commitment count differs from its manifest",
      );
    const descriptorFields = parseProtocolObject(
      input.descriptor.protocolObject.canonicalBytes,
    );
    const descriptorCommitments = descriptorFields.get(53);
    if (!Array.isArray(descriptorCommitments))
      throw new Error("manifest descriptor does not commit to its lanes");
    if (
      !sameBytes(
        canonicalEncode(manifestCommitments),
        canonicalEncode(descriptorCommitments),
      )
    )
      throw new Error(
        "signed revision lane commitments differ from its descriptor",
      );
    for (let index = 0; index < manifestCommitments.length; index += 1) {
      const embedded = manifestCommitments[index];
      if (!(embedded instanceof Map))
        throw new Error("signed revision lane commitment is malformed");
      const laneId = embedded.get(18);
      const scope = embedded.get(36);
      const objectHash = embedded.get(48);
      const ciphertextLength = embedded.get(72);
      if (
        !(laneId instanceof Uint8Array) ||
        laneId.length !== 16 ||
        typeof scope !== "number" ||
        !(objectHash instanceof Uint8Array) ||
        typeof ciphertextLength !== "number"
      )
        throw new Error("signed revision lane commitment is malformed");
      const commitmentScope = commitmentScopeFromField(scope);
      if (commitmentScope === null)
        throw new Error("signed revision lane commitment has an unknown scope");
      const ownerUserId = commitmentUserId(embedded.get(26));
      const originalProviderUserId = commitmentUserId(embedded.get(27));
      const commitment = input.commitments[index];
      if (
        !commitment ||
        commitment.laneObjectId !== bytesToUuid(laneId) ||
        commitment.scope !== commitmentScope ||
        commitment.ownerUserId !== ownerUserId ||
        commitment.originalProviderUserId !== originalProviderUserId ||
        commitment.ciphertextLength !== ciphertextLength ||
        !sameBytes(commitment.objectHash, objectHash)
      )
        throw new Error(
          "request commitment projection differs from the signed revision's committed lanes",
        );
    }
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
    // A rotation inner publication leaves the shared operation STAGED;
    // ProjectEpochRepository.rotate commits it once after all transitions.
    if (!input.rotationInner)
      await transaction.operation.update({
        where: { id: operation.id },
        data: {
          status: "COMMITTED",
          committedAt: new Date(),
          ...(input.finalizationDigest
            ? { finalizationDigest: databaseBytes(input.finalizationDigest) }
            : {}),
        },
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
      if (project?.lifecycle !== "ACTIVE") throw new ProjectNotActiveError();
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
      // Lock the Project row before the Environment insert: the foreign key
      // on environments.projectId would otherwise take a key-share lock on
      // the Project row that deadlocks against the FOR UPDATE taken later
      // inside publishRevisionInTransaction when two genesis creations run
      // concurrently in the same Project.
      await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const project = await transaction.project.findUnique({
        where: { id: input.projectId },
        select: { lifecycle: true, teamId: true },
      });
      if (project?.lifecycle !== "ACTIVE") throw new ProjectNotActiveError();
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
