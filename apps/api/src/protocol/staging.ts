import {
  bytesToUuid,
  ContractError,
  type FinalizePublicationRequest,
  importSigningPublicKey,
  parseProtocolObject,
  validateProtocolObject,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import type { RevisionPublicationInput } from "@dotrelay/database";
import { validateProtocolProjection } from "@dotrelay/database";
import { COMMAND_STAGE_OBJECT_ID } from "./constants";

type StagedRow = Readonly<{
  readonly objectId: string;
  readonly canonicalBytes: Uint8Array | Buffer;
  readonly digest: Uint8Array | Buffer;
}>;

export const collectStagedObjectIds = (
  request: FinalizePublicationRequest,
): readonly string[] => [
  COMMAND_STAGE_OBJECT_ID,
  request.revision.protocolObjectId,
  request.descriptor.protocolObjectId,
  ...request.lanes.map((lane) => lane.protocolObjectId),
];

export const uniqueStagedObjectIds = (
  ids: readonly string[],
): readonly string[] => [...new Set(ids)];

export const hasAllStagedObjects = (
  requestedIds: readonly string[],
  stagedRows: ReadonlyArray<{ readonly objectId: string }>,
): boolean => {
  const stagedIds = new Set(stagedRows.map((row) => row.objectId));
  return requestedIds.every((objectId) => stagedIds.has(objectId));
};

export const buildProtocolObjectFromStage = (
  stagedById: ReadonlyMap<string, StagedRow>,
  objectId: string,
  projectId: string,
  environmentId: string,
) => {
  const staged = stagedById.get(objectId);
  if (!staged) throw new ContractError("staged_object_missing");
  const parsed = parseProtocolObject(new Uint8Array(staged.canonicalBytes));
  validateProtocolObject(parsed);
  return {
    id: objectId,
    suite: "dotrelay-e2ee-v3-classical-webcrypto",
    formatVersion: 3,
    kind: parsed.get(1) as number,
    canonicalBytes: new Uint8Array(staged.canonicalBytes),
    digest: new Uint8Array(staged.digest),
    projectId,
    environmentId,
  };
};

export const verifyRevisionSignature = async (
  revisionObject: ReturnType<typeof buildProtocolObjectFromStage>,
  ed25519PublicKey: Uint8Array | Buffer,
): Promise<boolean> => {
  const parsedRevision = parseProtocolObject(revisionObject.canonicalBytes);
  const signature = parsedRevision.get(4);
  if (!(signature instanceof Uint8Array)) return false;
  return verifyProtocolObject(
    parsedRevision,
    signature,
    await importSigningPublicKey(new Uint8Array(ed25519PublicKey)),
  );
};

export const buildPublicationInput = (input: {
  readonly operationId: string;
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly commandStaged: StagedRow;
  readonly operationExpiresAt: Date | null;
  readonly finalizeRequest: FinalizePublicationRequest;
  readonly projectId: string;
  readonly environmentId: string;
  readonly stagedById: ReadonlyMap<string, StagedRow>;
}): RevisionPublicationInput => {
  const build = (objectId: string) =>
    buildProtocolObjectFromStage(
      input.stagedById,
      objectId,
      input.projectId,
      input.environmentId,
    );
  const revisionObject = build(input.finalizeRequest.revision.protocolObjectId);
  validateProtocolProjection(revisionObject);
  const parsedRevision = parseProtocolObject(revisionObject.canonicalBytes);
  if (
    parsedRevision.get(1) !== 16 ||
    !(parsedRevision.get(16) instanceof Uint8Array) ||
    bytesToUuid(parsedRevision.get(16) as Uint8Array) !==
      input.finalizeRequest.revision.id ||
    parsedRevision.get(35) !==
      (
        {
          GENESIS: 1,
          MANIFEST_UPDATE: 2,
          ROLLBACK: 3,
          EPOCH_TRANSITION: 4,
          USER_KEY_ROTATION: 5,
        } as const
      )[input.finalizeRequest.revision.mutation] ||
    BigInt(parsedRevision.get(30) as number | bigint) !==
      BigInt(input.finalizeRequest.revision.projectEpoch) ||
    BigInt(parsedRevision.get(34) as number | bigint) !==
      BigInt(input.finalizeRequest.revision.authoredAtMs)
  )
    throw new ContractError("invalid_crypto_object");
  if (input.finalizeRequest.revision.mutation === "ROLLBACK")
    validateRollbackLaneScope(parsedRevision, input, build);
  const operationKind =
    input.finalizeRequest.revision.mutation === "ROLLBACK"
      ? "ROLLBACK"
      : "REVISION_PUBLICATION";
  return {
    operation: {
      id: input.operationId,
      actorUserId: input.actorUserId,
      actorDeviceId: input.actorDeviceId,
      kind: operationKind,
      commandBytes: new Uint8Array(input.commandStaged.canonicalBytes),
      commandDigest: new Uint8Array(input.commandStaged.digest),
      ...(input.operationExpiresAt
        ? { expiresAt: input.operationExpiresAt }
        : {}),
    },
    environmentId: input.environmentId,
    expectedHeadId: input.finalizeRequest.expectedHeadId,
    revision: {
      id: input.finalizeRequest.revision.id,
      protocolObjectId: input.finalizeRequest.revision.protocolObjectId,
      ...(input.finalizeRequest.revision.parentHash
        ? { parentHash: input.finalizeRequest.revision.parentHash }
        : {}),
      projectEpoch: BigInt(input.finalizeRequest.revision.projectEpoch),
      mutation: input.finalizeRequest.revision.mutation,
      authoredAtMs: BigInt(input.finalizeRequest.revision.authoredAtMs),
      ...(input.finalizeRequest.revision.rollbackTargetId
        ? { rollbackTargetId: input.finalizeRequest.revision.rollbackTargetId }
        : {}),
    },
    revisionObject,
    descriptor: {
      protocolObject: build(input.finalizeRequest.descriptor.protocolObjectId),
      schemaVersion: input.finalizeRequest.descriptor.schemaVersion,
      descriptorHash: input.finalizeRequest.descriptor.descriptorHash,
      laneCount: input.finalizeRequest.descriptor.laneCount,
    },
    lanes: input.finalizeRequest.lanes.map((lane) => {
      const protocolObject = build(lane.protocolObjectId);
      validateLaneOwnership(
        lane,
        parseProtocolObject(protocolObject.canonicalBytes),
        input.actorUserId,
      );
      return {
        lane: {
          id: lane.id,
          protocolObjectId: lane.protocolObjectId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          scope: lane.scope,
          ...(lane.ownerUserId ? { ownerUserId: lane.ownerUserId } : {}),
          ...(lane.originalProviderUserId
            ? { originalProviderUserId: lane.originalProviderUserId }
            : {}),
          projectEpoch: BigInt(lane.projectEpoch),
          ...(lane.valueGeneration !== undefined
            ? { valueGeneration: BigInt(lane.valueGeneration) }
            : {}),
          plaintextLength: lane.plaintextLength,
          ciphertextLength: lane.ciphertextLength,
          ciphertextHash: lane.ciphertextHash,
        },
        protocolObject,
      };
    }),
    commitments: input.finalizeRequest.commitments.map((commitment) => ({
      ordinal: commitment.ordinal,
      laneObjectId: commitment.laneObjectId,
      objectHash: commitment.objectHash,
      projectEpoch: BigInt(commitment.projectEpoch),
      scope: commitment.scope,
      ciphertextLength: commitment.ciphertextLength,
      ...(commitment.valueGeneration !== undefined
        ? { valueGeneration: BigInt(commitment.valueGeneration) }
        : {}),
      ...(commitment.ownerUserId
        ? { ownerUserId: commitment.ownerUserId }
        : {}),
      ...(commitment.originalProviderUserId
        ? { originalProviderUserId: commitment.originalProviderUserId }
        : {}),
    })),
    audit: {
      kind:
        input.finalizeRequest.revision.mutation === "ROLLBACK"
          ? "ROLLBACK_PUBLISHED"
          : "REVISION_PUBLISHED",
      entityKind: "ENVIRONMENT",
      entityId: input.environmentId,
    },
  };
};

const validateRollbackLaneScope = (
  revision: ReturnType<typeof parseProtocolObject>,
  input: {
    readonly finalizeRequest: FinalizePublicationRequest;
  },
  build: (objectId: string) => ReturnType<typeof buildProtocolObjectFromStage>,
): void => {
  const selected = revision.get(68);
  if (!Array.isArray(selected) || selected.length === 0)
    throw new ContractError("invalid_crypto_object");
  const selectedIds = new Set<string>();
  for (const value of selected) {
    if (!(value instanceof Uint8Array) || value.length !== 16)
      throw new ContractError("invalid_crypto_object");
    const id = bytesToUuid(value);
    if (selectedIds.has(id)) throw new ContractError("invalid_crypto_object");
    selectedIds.add(id);
  }
  const laneVariableIds = new Set<string>();
  for (const lane of input.finalizeRequest.lanes) {
    const object = parseProtocolObject(
      build(lane.protocolObjectId).canonicalBytes,
    );
    const variableId = object.get(15);
    const scope = object.get(36);
    if (!(variableId instanceof Uint8Array) || variableId.length !== 16)
      throw new ContractError("invalid_crypto_object");
    if (scope === 1) throw new ContractError("invalid_crypto_object");
    laneVariableIds.add(bytesToUuid(variableId));
  }
  if (
    laneVariableIds.size !== selectedIds.size ||
    [...laneVariableIds].some((id) => !selectedIds.has(id))
  )
    throw new ContractError("invalid_crypto_object");
};

const validateLaneOwnership = (
  lane: FinalizePublicationRequest["lanes"][number],
  object: ReturnType<typeof parseProtocolObject>,
  actorUserId: string,
): void => {
  if (object.get(1) !== 13) throw new ContractError("invalid_crypto_object");
  const readOptionalUuid = (field: number): string | undefined => {
    const value = object.get(field);
    if (value === undefined) return undefined;
    if (!(value instanceof Uint8Array) || value.length !== 16)
      throw new ContractError("invalid_crypto_object");
    return bytesToUuid(value);
  };
  const ownerUserId = readOptionalUuid(26);
  const originalProviderUserId = readOptionalUuid(27);
  if (
    lane.scope === "VARIABLE_DEFINITION" ||
    lane.scope === "ENVIRONMENT_DEFINITION"
  ) {
    if (ownerUserId || originalProviderUserId)
      throw new ContractError("invalid_crypto_object");
    return;
  }
  if (lane.scope === "USER_DEFINED_VALUE") {
    if (ownerUserId !== actorUserId || originalProviderUserId !== undefined)
      throw new ContractError("invalid_crypto_object");
    return;
  }
  if (
    lane.scope === "SHARED_VALUE" &&
    (originalProviderUserId !== actorUserId || ownerUserId !== undefined)
  )
    throw new ContractError("invalid_crypto_object");
};
