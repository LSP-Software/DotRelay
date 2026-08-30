import {
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
    lanes: input.finalizeRequest.lanes.map((lane) => ({
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
      protocolObject: build(lane.protocolObjectId),
    })),
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
