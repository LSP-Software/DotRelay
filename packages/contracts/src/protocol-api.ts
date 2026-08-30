import { CBOR_LIMITS, canonicalEncode, type CborValue } from "./cbor";
import { contractError } from "./errors";
import { parseJsonObject, parsePagination, type Pagination } from "./api";
import { utf8Encode } from "./runtime";

export const PROTOCOL_MEDIA_TYPE =
  "application/vnd.dotrelay.e2ee-v3+cbor" as const;

export const DEVICE_ID_HEADER = "X-DotRelay-Device-Id" as const;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sha384HexPattern = /^[0-9a-f]{96}$/i;

export const parseUuid = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !uuidPattern.test(value))
    contractError("invalid_request");
  return value.toLowerCase();
};

export const parseSha384Hex = (value: unknown, field: string): Uint8Array => {
  if (typeof value !== "string" || !sha384HexPattern.test(value))
    contractError("invalid_request");
  const bytes = new Uint8Array(48);
  for (let index = 0; index < 48; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

export const sha384ToHex = (value: Uint8Array): string =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export type BeginOperationRequest = Readonly<{
  readonly operationId: string;
  readonly kind:
    | "REVISION_PUBLICATION"
    | "ROLLBACK"
    | "EPOCH_ROTATION";
  readonly commandDigest: Uint8Array;
  readonly expiresAt?: string;
}>;

export const parseBeginOperationRequest = (
  value: unknown,
): BeginOperationRequest => {
  const body = parseJsonObject<{
    operationId?: unknown;
    kind?: unknown;
    commandDigest?: unknown;
    expiresAt?: unknown;
  }>(value, ["operationId", "kind", "commandDigest", "expiresAt"]);
  const kind = body.kind;
  if (
    kind !== "REVISION_PUBLICATION" &&
    kind !== "ROLLBACK" &&
    kind !== "EPOCH_ROTATION"
  )
    contractError("invalid_request");
  const request: {
    operationId: string;
    kind: BeginOperationRequest["kind"];
    commandDigest: Uint8Array;
    expiresAt?: string;
  } = {
    operationId: parseUuid(body.operationId, "operationId"),
    kind,
    commandDigest: parseSha384Hex(body.commandDigest, "commandDigest"),
  };
  if (body.expiresAt !== undefined) {
    if (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt)))
      contractError("invalid_request");
    request.expiresAt = body.expiresAt;
  }
  return request;
};

export type SyncRequest = Readonly<{
  readonly trustedRevisionId: string;
  readonly trustedRevisionHash: Uint8Array;
  readonly pagination: Pagination;
}>;

export const parseSyncRequest = (value: unknown): SyncRequest => {
  const body = parseJsonObject<{
    trustedRevisionId?: unknown;
    trustedRevisionHash?: unknown;
    pagination?: unknown;
  }>(value, ["trustedRevisionId", "trustedRevisionHash", "pagination"]);
  return Object.freeze({
    trustedRevisionId: parseUuid(body.trustedRevisionId, "trustedRevisionId"),
    trustedRevisionHash: parseSha384Hex(
      body.trustedRevisionHash,
      "trustedRevisionHash",
    ),
    pagination:
      body.pagination === undefined
        ? Object.freeze({})
        : parsePagination(body.pagination),
  });
};

export type FinalizePublicationRequest = Readonly<{
  readonly environmentId: string;
  readonly expectedHeadId: string | null;
  readonly revision: Readonly<{
    readonly id: string;
    readonly protocolObjectId: string;
    readonly parentHash?: Uint8Array;
    readonly projectEpoch: number;
    readonly mutation:
      | "GENESIS"
      | "MANIFEST_UPDATE"
      | "ROLLBACK"
      | "EPOCH_TRANSITION"
      | "USER_KEY_ROTATION";
    readonly authoredAtMs: number;
    readonly rollbackTargetId?: string;
  }>;
  readonly descriptor: Readonly<{
    readonly protocolObjectId: string;
    readonly schemaVersion: number;
    readonly descriptorHash: Uint8Array;
    readonly laneCount: number;
  }>;
  readonly lanes: ReadonlyArray<
    Readonly<{
      readonly id: string;
      readonly protocolObjectId: string;
      readonly scope:
        | "ENVIRONMENT_DEFINITION"
        | "VARIABLE_DEFINITION"
        | "SHARED_VALUE"
        | "USER_DEFINED_VALUE";
      readonly ownerUserId?: string;
      readonly originalProviderUserId?: string;
      readonly projectEpoch: number;
      readonly valueGeneration?: number;
      readonly plaintextLength: number;
      readonly ciphertextLength: number;
      readonly ciphertextHash: Uint8Array;
    }>
  >;
  readonly commitments: ReadonlyArray<
    Readonly<{
      readonly ordinal: number;
      readonly laneObjectId: string;
      readonly objectHash: Uint8Array;
      readonly projectEpoch: number;
      readonly valueGeneration?: number;
      readonly scope:
        | "ENVIRONMENT_DEFINITION"
        | "VARIABLE_DEFINITION"
        | "SHARED_VALUE"
        | "USER_DEFINED_VALUE";
      readonly ownerUserId?: string;
      readonly originalProviderUserId?: string;
      readonly ciphertextLength: number;
    }>
  >;
}>;

const parseLaneScope = (
  value: unknown,
):
  | "ENVIRONMENT_DEFINITION"
  | "VARIABLE_DEFINITION"
  | "SHARED_VALUE"
  | "USER_DEFINED_VALUE" => {
  if (
    value !== "ENVIRONMENT_DEFINITION" &&
    value !== "VARIABLE_DEFINITION" &&
    value !== "SHARED_VALUE" &&
    value !== "USER_DEFINED_VALUE"
  )
    contractError("invalid_request");
  return value;
};

const parseMutation = (
  value: unknown,
): FinalizePublicationRequest["revision"]["mutation"] => {
  if (
    value !== "GENESIS" &&
    value !== "MANIFEST_UPDATE" &&
    value !== "ROLLBACK" &&
    value !== "EPOCH_TRANSITION" &&
    value !== "USER_KEY_ROTATION"
  )
    contractError("invalid_request");
  return value;
};

export const parseFinalizePublicationRequest = (
  value: unknown,
): FinalizePublicationRequest => {
  const body = parseJsonObject<{
    environmentId?: unknown;
    expectedHeadId?: unknown;
    revision?: unknown;
    descriptor?: unknown;
    lanes?: unknown;
    commitments?: unknown;
  }>(value, [
    "environmentId",
    "expectedHeadId",
    "revision",
    "descriptor",
    "lanes",
    "commitments",
  ]);
  const revisionBody = parseJsonObject<{
    id?: unknown;
    protocolObjectId?: unknown;
    parentHash?: unknown;
    projectEpoch?: unknown;
    mutation?: unknown;
    authoredAtMs?: unknown;
    rollbackTargetId?: unknown;
  }>(body.revision, [
    "id",
    "protocolObjectId",
    "parentHash",
    "projectEpoch",
    "mutation",
    "authoredAtMs",
    "rollbackTargetId",
  ]);
  const descriptorBody = parseJsonObject<{
    protocolObjectId?: unknown;
    schemaVersion?: unknown;
    descriptorHash?: unknown;
    laneCount?: unknown;
  }>(body.descriptor, [
    "protocolObjectId",
    "schemaVersion",
    "descriptorHash",
    "laneCount",
  ]);
  if (
    typeof revisionBody.projectEpoch !== "number" ||
    !Number.isInteger(revisionBody.projectEpoch) ||
    revisionBody.projectEpoch < 0
  )
    contractError("invalid_request");
  if (
    typeof revisionBody.authoredAtMs !== "number" ||
    !Number.isInteger(revisionBody.authoredAtMs) ||
    revisionBody.authoredAtMs < 0
  )
    contractError("invalid_request");
  if (
    typeof descriptorBody.schemaVersion !== "number" ||
    !Number.isInteger(descriptorBody.schemaVersion) ||
    descriptorBody.schemaVersion < 1
  )
    contractError("invalid_request");
  if (
    typeof descriptorBody.laneCount !== "number" ||
    !Number.isInteger(descriptorBody.laneCount) ||
    descriptorBody.laneCount < 0
  )
    contractError("invalid_request");
  if (!Array.isArray(body.lanes) || !Array.isArray(body.commitments))
    contractError("invalid_request");
  return Object.freeze({
    environmentId: parseUuid(body.environmentId, "environmentId"),
    expectedHeadId:
      body.expectedHeadId === null
        ? null
        : parseUuid(body.expectedHeadId, "expectedHeadId"),
    revision: Object.freeze({
      id: parseUuid(revisionBody.id, "revision.id"),
      protocolObjectId: parseUuid(
        revisionBody.protocolObjectId,
        "revision.protocolObjectId",
      ),
      projectEpoch: revisionBody.projectEpoch,
      mutation: parseMutation(revisionBody.mutation),
      authoredAtMs: revisionBody.authoredAtMs,
      ...(revisionBody.parentHash === undefined
        ? {}
        : {
            parentHash: parseSha384Hex(
              revisionBody.parentHash,
              "revision.parentHash",
            ),
          }),
      ...(revisionBody.rollbackTargetId === undefined
        ? {}
        : {
            rollbackTargetId: parseUuid(
              revisionBody.rollbackTargetId,
              "revision.rollbackTargetId",
            ),
          }),
    }),
    descriptor: Object.freeze({
      protocolObjectId: parseUuid(
        descriptorBody.protocolObjectId,
        "descriptor.protocolObjectId",
      ),
      schemaVersion: descriptorBody.schemaVersion,
      descriptorHash: parseSha384Hex(
        descriptorBody.descriptorHash,
        "descriptor.descriptorHash",
      ),
      laneCount: descriptorBody.laneCount,
    }),
    lanes: Object.freeze(
      body.lanes.map((laneValue) => {
        const lane = parseJsonObject<{
          id?: unknown;
          protocolObjectId?: unknown;
          scope?: unknown;
          ownerUserId?: unknown;
          originalProviderUserId?: unknown;
          projectEpoch?: unknown;
          valueGeneration?: unknown;
          plaintextLength?: unknown;
          ciphertextLength?: unknown;
          ciphertextHash?: unknown;
        }>(laneValue, [
          "id",
          "protocolObjectId",
          "scope",
          "ownerUserId",
          "originalProviderUserId",
          "projectEpoch",
          "valueGeneration",
          "plaintextLength",
          "ciphertextLength",
          "ciphertextHash",
        ]);
        if (
          typeof lane.projectEpoch !== "number" ||
          !Number.isInteger(lane.projectEpoch) ||
          lane.projectEpoch < 0 ||
          typeof lane.plaintextLength !== "number" ||
          !Number.isInteger(lane.plaintextLength) ||
          lane.plaintextLength < 0 ||
          typeof lane.ciphertextLength !== "number" ||
          !Number.isInteger(lane.ciphertextLength) ||
          lane.ciphertextLength < 0
        )
          contractError("invalid_request");
        const parsed: {
          id: string;
          protocolObjectId: string;
          scope: ReturnType<typeof parseLaneScope>;
          projectEpoch: number;
          plaintextLength: number;
          ciphertextLength: number;
          ciphertextHash: Uint8Array;
          ownerUserId?: string;
          originalProviderUserId?: string;
          valueGeneration?: number;
        } = {
          id: parseUuid(lane.id, "lane.id"),
          protocolObjectId: parseUuid(
            lane.protocolObjectId,
            "lane.protocolObjectId",
          ),
          scope: parseLaneScope(lane.scope),
          projectEpoch: lane.projectEpoch,
          plaintextLength: lane.plaintextLength,
          ciphertextLength: lane.ciphertextLength,
          ciphertextHash: parseSha384Hex(lane.ciphertextHash, "lane.ciphertextHash"),
        };
        if (lane.ownerUserId !== undefined)
          parsed.ownerUserId = parseUuid(lane.ownerUserId, "lane.ownerUserId");
        if (lane.originalProviderUserId !== undefined)
          parsed.originalProviderUserId = parseUuid(
            lane.originalProviderUserId,
            "lane.originalProviderUserId",
          );
        if (lane.valueGeneration !== undefined) {
          if (
            typeof lane.valueGeneration !== "number" ||
            !Number.isInteger(lane.valueGeneration) ||
            lane.valueGeneration < 0
          )
            contractError("invalid_request");
          parsed.valueGeneration = lane.valueGeneration;
        }
        return Object.freeze(parsed);
      }),
    ),
    commitments: Object.freeze(
      body.commitments.map((commitmentValue) => {
        const commitment = parseJsonObject<{
          ordinal?: unknown;
          laneObjectId?: unknown;
          objectHash?: unknown;
          projectEpoch?: unknown;
          valueGeneration?: unknown;
          scope?: unknown;
          ownerUserId?: unknown;
          originalProviderUserId?: unknown;
          ciphertextLength?: unknown;
        }>(commitmentValue, [
          "ordinal",
          "laneObjectId",
          "objectHash",
          "projectEpoch",
          "valueGeneration",
          "scope",
          "ownerUserId",
          "originalProviderUserId",
          "ciphertextLength",
        ]);
        if (
          typeof commitment.ordinal !== "number" ||
          !Number.isInteger(commitment.ordinal) ||
          commitment.ordinal < 0 ||
          typeof commitment.projectEpoch !== "number" ||
          !Number.isInteger(commitment.projectEpoch) ||
          commitment.projectEpoch < 0 ||
          typeof commitment.ciphertextLength !== "number" ||
          !Number.isInteger(commitment.ciphertextLength) ||
          commitment.ciphertextLength < 0
        )
          contractError("invalid_request");
        const parsed: {
          ordinal: number;
          laneObjectId: string;
          objectHash: Uint8Array;
          projectEpoch: number;
          scope: ReturnType<typeof parseLaneScope>;
          ciphertextLength: number;
          valueGeneration?: number;
          ownerUserId?: string;
          originalProviderUserId?: string;
        } = {
          ordinal: commitment.ordinal,
          laneObjectId: parseUuid(commitment.laneObjectId, "commitment.laneObjectId"),
          objectHash: parseSha384Hex(commitment.objectHash, "commitment.objectHash"),
          projectEpoch: commitment.projectEpoch,
          scope: parseLaneScope(commitment.scope),
          ciphertextLength: commitment.ciphertextLength,
        };
        if (commitment.valueGeneration !== undefined) {
          if (
            typeof commitment.valueGeneration !== "number" ||
            !Number.isInteger(commitment.valueGeneration) ||
            commitment.valueGeneration < 0
          )
            contractError("invalid_request");
          parsed.valueGeneration = commitment.valueGeneration;
        }
        if (commitment.ownerUserId !== undefined)
          parsed.ownerUserId = parseUuid(
            commitment.ownerUserId,
            "commitment.ownerUserId",
          );
        if (commitment.originalProviderUserId !== undefined)
          parsed.originalProviderUserId = parseUuid(
            commitment.originalProviderUserId,
            "commitment.originalProviderUserId",
          );
        return Object.freeze(parsed);
      }),
    ),
  });
};

export type SyncRevisionWire = Readonly<{
  readonly id: string;
  readonly digest: Uint8Array;
  readonly parentId: string | null;
  readonly parentHash: Uint8Array | null;
  readonly mutation: number;
  readonly projectEpoch: bigint;
  readonly authoredAtMs: bigint;
  readonly rollbackTargetId: string | null;
  readonly objects: ReadonlyArray<
    Readonly<{
      readonly objectId: string;
      readonly canonicalBytes: Uint8Array;
      readonly digest: Uint8Array;
    }>
  >;
}>;

export type SyncPageWire = Readonly<{
  readonly environmentId: string;
  readonly trustedRevisionId: string;
  readonly trustedRevisionHash: Uint8Array;
  readonly currentHeadId: string | null;
  readonly currentHeadHash: Uint8Array | null;
  readonly projectEpoch: bigint;
  readonly revisions: readonly SyncRevisionWire[];
  readonly nextCursor: string | null;
}>;

const SYNC_FIELD = Object.freeze({
  environmentId: 128,
  trustedRevisionId: 129,
  trustedRevisionHash: 130,
  currentHeadId: 131,
  currentHeadHash: 132,
  projectEpoch: 133,
  revisions: 134,
  nextCursor: 135,
  revisionId: 136,
  revisionDigest: 137,
  parentId: 138,
  parentHash: 139,
  mutation: 140,
  authoredAtMs: 141,
  rollbackTargetId: 142,
  objects: 143,
  objectId: 144,
  canonicalBytes: 145,
  objectDigest: 146,
} as const);

const encodeRevision = (revision: SyncRevisionWire): CborValue => {
  const fields = new Map<number, CborValue>([
    [SYNC_FIELD.revisionId, utf8Encode(revision.id)],
    [SYNC_FIELD.revisionDigest, revision.digest],
    [SYNC_FIELD.mutation, Number(revision.mutation)],
    [SYNC_FIELD.projectEpoch, revision.projectEpoch],
    [SYNC_FIELD.authoredAtMs, revision.authoredAtMs],
    [
      SYNC_FIELD.objects,
      revision.objects.map(
        (object) =>
          new Map<number, CborValue>([
            [SYNC_FIELD.objectId, utf8Encode(object.objectId)],
            [SYNC_FIELD.canonicalBytes, object.canonicalBytes],
            [SYNC_FIELD.objectDigest, object.digest],
          ]),
      ),
    ],
  ]);
  if (revision.parentId !== null)
    fields.set(SYNC_FIELD.parentId, utf8Encode(revision.parentId));
  if (revision.parentHash !== null)
    fields.set(SYNC_FIELD.parentHash, revision.parentHash);
  if (revision.rollbackTargetId !== null)
    fields.set(SYNC_FIELD.rollbackTargetId, utf8Encode(revision.rollbackTargetId));
  return fields;
};

export const encodeSyncPage = (page: SyncPageWire): Uint8Array => {
  let objectCount = 0;
  let byteCount = 0;
  for (const revision of page.revisions) {
    objectCount += revision.objects.length + 1;
    for (const object of revision.objects) {
      byteCount += object.canonicalBytes.length;
    }
  }
  if (
    objectCount > CBOR_LIMITS.maxSyncObjects ||
    byteCount > CBOR_LIMITS.maxSyncBytes
  )
    contractError("payload_too_large");
  const envelope = new Map<number, CborValue>([
    [SYNC_FIELD.environmentId, utf8Encode(page.environmentId)],
    [SYNC_FIELD.trustedRevisionId, utf8Encode(page.trustedRevisionId)],
    [SYNC_FIELD.trustedRevisionHash, page.trustedRevisionHash],
    [SYNC_FIELD.projectEpoch, page.projectEpoch],
    [
      SYNC_FIELD.revisions,
      page.revisions.map((revision) => encodeRevision(revision)),
    ],
  ]);
  if (page.currentHeadId !== null)
    envelope.set(SYNC_FIELD.currentHeadId, utf8Encode(page.currentHeadId));
  if (page.currentHeadHash !== null)
    envelope.set(SYNC_FIELD.currentHeadHash, page.currentHeadHash);
  if (page.nextCursor !== null)
    envelope.set(SYNC_FIELD.nextCursor, page.nextCursor);
  return canonicalEncode(envelope);
};

export const parseSyncCursor = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  if (value.length === 0 || value.length > 1024) contractError("invalid_request");
  return value;
};

export const formatSyncCursor = (
  revisionId: string,
  revisionHash: Uint8Array,
): string => `${revisionId}:${sha384ToHex(revisionHash)}`;

export const parseSyncCursorValue = (
  value: string,
): Readonly<{ revisionId: string; revisionHash: Uint8Array }> => {
  const separator = value.indexOf(":");
  if (separator <= 0) contractError("invalid_request");
  return Object.freeze({
    revisionId: parseUuid(value.slice(0, separator), "cursor.revisionId"),
    revisionHash: parseSha384Hex(
      value.slice(separator + 1),
      "cursor.revisionHash",
    ),
  });
};
