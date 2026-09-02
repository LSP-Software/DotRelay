import {
  bytesToUuid,
  type CborValue,
  canonicalEncode,
  decodeCiphertextEnvelope,
  encodeProtocolObject,
  type FinalizePublicationRequest,
  open,
  type ProtocolObject,
  parseProtocolObject,
  protocolObjectFromFields,
  SUITE_VALUE,
  type SyncPageWire,
  seal,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  ProtocolVerificationError,
  verifySignedProtocolObject,
} from "../trust/verify";
import { validateRevisionManifest } from "./manifest";

export type PublicationReview = Readonly<{
  readonly accepted: boolean;
  readonly mutationKind: number;
  readonly manifestVariables: number;
  readonly manifestLaneCommitments: number;
}>;

export const reviewPublication = (
  revisionBytes: Uint8Array,
): PublicationReview => {
  const revision = parseProtocolObject(revisionBytes);
  const mutationKind = revision.get(35);
  if (typeof mutationKind !== "number" || !Number.isSafeInteger(mutationKind))
    throw new TypeError("revision mutation kind is missing");
  const counts = validateRevisionManifest(revision);
  return Object.freeze({
    accepted: mutationKind === 1 || mutationKind === 2 || mutationKind === 3,
    mutationKind,
    manifestVariables: counts.variables,
    manifestLaneCommitments: counts.laneCommitments,
  });
};

export const assertPublicationAccepted = (review: PublicationReview): void => {
  if (!review.accepted)
    throw new Error("publication review rejected the revision mutation");
};

export const isRollbackRevision = (revision: ProtocolObject): boolean =>
  revision.get(1) === 16 && revision.get(35) === 3;

export const validateRollbackRevision = (
  revisionBytes: Uint8Array,
): Readonly<{
  rollbackTargetId: Uint8Array;
  selectedLanes: readonly unknown[];
}> => {
  const revision = parseProtocolObject(revisionBytes);
  if (!isRollbackRevision(revision))
    throw new TypeError("expected rollback revision");
  const rollbackTargetId = revision.get(21);
  const selectedLanes = revision.get(68);
  if (
    !(rollbackTargetId instanceof Uint8Array) ||
    rollbackTargetId.length !== 16
  )
    throw new TypeError("rollback target revision id is invalid");
  if (!Array.isArray(selectedLanes))
    throw new TypeError("rollback selected lanes are missing");
  return Object.freeze({
    rollbackTargetId,
    selectedLanes,
  });
};

export type PublicationVariable = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ownership: "SHARED_VALUE" | "USER_DEFINED_VALUE";
  readonly value: string | null;
  readonly required: boolean;
  readonly tombstone?: boolean;
  readonly hasDraftChange: boolean;
}>;

export type PublicationContext = Readonly<{
  readonly serverProfileId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly projectEpoch: number;
  readonly expectedHeadId: string | null;
  readonly expectedHeadHash: Uint8Array | null;
  readonly valueRecipientPublicKey: CryptoKey;
  readonly userDefinedValueRecipientPublicKey?: CryptoKey;
  readonly signingPrivateKey: CryptoKey;
  readonly revisionSigningPublicKey?: Uint8Array;
  readonly trustedRevisionId?: string;
  readonly trustedRevisionHash?: Uint8Array;
  readonly mutation?: "GENESIS" | "MANIFEST_UPDATE" | "ROLLBACK";
  readonly rollbackTargetId?: string;
  readonly rollbackSelectedVariableIds?: readonly string[];
}>;

export type SyncDisclosureOptions = Readonly<{
  readonly actorUserId?: string;
}>;

export type StagedPublicationObject = Readonly<{
  readonly objectId: string;
  readonly bytes: Uint8Array;
}>;

export type PublicationArtifacts = Readonly<{
  readonly request: FinalizePublicationRequest;
  readonly commandBytes: Uint8Array;
  readonly stagedObjects: readonly StagedPublicationObject[];
  readonly encryptedLaneCount: number;
  readonly encryptedBytes: number;
  readonly tombstoneLaneCount: number;
  readonly servicePlaintextBytes: 0;
}>;

export type DecodedVariable = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ownership: "SHARED_VALUE" | "USER_DEFINED_VALUE";
  readonly value: string | null;
  readonly required: boolean;
  readonly tombstone: boolean;
}>;

const zeroBytes = (length: number): Uint8Array => new Uint8Array(length);

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIABLE_NAME_MAX_BYTES = 256;
const DESCRIPTION_MAX_BYTES = 16 * 1024;
const VALUE_MAX_BYTES = 1024 * 1024;

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

const uuid = (): string => crypto.randomUUID();

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const signedObject = async (
  kind: number,
  fields: ReadonlyMap<number, CborValue>,
  signingPrivateKey: CryptoKey,
): Promise<
  Readonly<{
    readonly id: string;
    readonly bytes: Uint8Array;
    readonly object: ProtocolObject;
  }>
> => {
  const objectId = uuid();
  const unsigned = protocolObjectFromFields(kind, fields);
  const unsignedBytes = canonicalEncode(unsigned);
  const envelope = new Map<number, CborValue>([
    ...fields,
    [3, unsignedBytes],
    [4, zeroBytes(64)],
  ]);
  const placeholder = protocolObjectFromFields(kind, envelope);
  const signature = await signProtocolObject(placeholder, signingPrivateKey);
  envelope.set(4, signature);
  const object = protocolObjectFromFields(kind, envelope);
  return Object.freeze({
    id: objectId,
    bytes: encodeProtocolObject(object),
    object,
  });
};

const scopeValue = (ownership: PublicationVariable["ownership"]): number =>
  ownership === "SHARED_VALUE" ? 3 : 4;

const mutationFields = (input: {
  readonly context: PublicationContext;
  readonly revisionId: string;
  readonly descriptorBytes: Uint8Array;
  readonly descriptorHash: Uint8Array;
  readonly laneCommitments: CborValue;
  readonly changedVariableIds: readonly string[];
  readonly mutationKind: number;
  readonly rollbackFields: ReadonlyArray<readonly [number, CborValue]>;
  readonly authoredAtMs: number;
}): ReadonlyMap<number, CborValue> =>
  new Map<number, CborValue>([
    [8, uuidToBytes(input.context.serverProfileId)],
    [11, uuidToBytes(input.context.teamId)],
    [13, uuidToBytes(input.context.projectId)],
    [14, uuidToBytes(input.context.environmentId)],
    [16, uuidToBytes(input.revisionId)],
    [17, uuidToBytes(uuid())],
    [
      19,
      uuidToBytes(input.context.expectedHeadId ?? input.context.environmentId),
    ],
    [20, input.context.expectedHeadHash ?? zeroBytes(48)],
    [22, uuidToBytes(input.context.actorUserId)],
    [23, uuidToBytes(input.context.actorDeviceId)],
    [30, input.context.projectEpoch],
    [34, input.authoredAtMs],
    [35, input.mutationKind],
    [50, 1],
    [51, input.descriptorBytes],
    [52, input.descriptorHash],
    [53, input.laneCommitments],
    [54, input.changedVariableIds.map(uuidToBytes)],
    ...input.rollbackFields,
  ]);

const associatedData = (
  variableId: string,
  revisionId: string,
  scope: number,
): Uint8Array =>
  canonicalEncode(
    new Map<number, CborValue>([
      [15, uuidToBytes(variableId)],
      [16, uuidToBytes(revisionId)],
      [36, scope],
    ]),
  );

const definitionPlaintext = (variable: PublicationVariable): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      name: variable.name,
      description: variable.description,
      ownership: variable.ownership,
      required: variable.required,
      tombstone: variable.tombstone === true,
    }),
  );

export const validatePublicationVariables = (
  variables: readonly PublicationVariable[],
): string | null => {
  if (variables.length > 10_000)
    return "Manifest exceeds the 10,000 Variable limit.";
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const variable of variables) {
    if (!variable.id || ids.has(variable.id))
      return `Variable id "${variable.id}" is duplicated.`;
    ids.add(variable.id);
    if (!VARIABLE_NAME_PATTERN.test(variable.name))
      return `Variable name "${variable.name}" does not match the required name rules.`;
    if (utf8ByteLength(variable.name) > VARIABLE_NAME_MAX_BYTES)
      return "Variable name exceeds the 256-byte limit.";
    if (utf8ByteLength(variable.description) > DESCRIPTION_MAX_BYTES)
      return "Description exceeds the 16 KiB limit.";
    if (
      variable.value !== null &&
      utf8ByteLength(variable.value) > VALUE_MAX_BYTES
    )
      return "Value exceeds the 1 MiB limit.";
    if (variable.tombstone) {
      if (variable.value !== null) return "A tombstone cannot retain a Value.";
      continue;
    }
    if (variable.required && variable.value === null)
      return `required Variable "${variable.name}" cannot have an absent Value.`;
    if (names.has(variable.name))
      return `duplicate live Variable name "${variable.name}".`;
    names.add(variable.name);
  }
  return null;
};

const makeLane = async (
  input: Readonly<{
    readonly context: PublicationContext;
    readonly variable: PublicationVariable;
    readonly revisionId: string;
    readonly scope: 2 | 3 | 4;
    readonly plaintext: Uint8Array;
    readonly recipientPublicKey: CryptoKey;
    readonly ownerUserId?: string;
    readonly originalProviderUserId?: string;
  }>,
): Promise<
  Readonly<{
    readonly lane: FinalizePublicationRequest["lanes"][number];
    readonly commitment: FinalizePublicationRequest["commitments"][number];
    readonly staged: StagedPublicationObject;
    readonly encryptedBytes: number;
  }>
> => {
  const { context, variable } = input;
  const laneId = uuid();
  const envelopeBytes = await seal(
    input.plaintext,
    input.recipientPublicKey,
    associatedData(variable.id, input.revisionId, input.scope),
  );
  const envelope = decodeCiphertextEnvelope(envelopeBytes);
  const ciphertext = envelope.get(47);
  const ciphertextHash = envelope.get(48);
  const iv = envelope.get(46);
  const salt = envelope.get(44);
  const ephemeralPublicKey = envelope.get(45);
  const ciphertextLength = envelope.get(72);
  if (
    !(ciphertext instanceof Uint8Array) ||
    !(ciphertextHash instanceof Uint8Array) ||
    !(iv instanceof Uint8Array) ||
    !(salt instanceof Uint8Array) ||
    !(ephemeralPublicKey instanceof Uint8Array) ||
    typeof ciphertextLength !== "number"
  )
    throw new Error("encrypted lane envelope is malformed");
  const laneScope =
    input.scope === 2
      ? ("VARIABLE_DEFINITION" as const)
      : input.scope === 3
        ? ("SHARED_VALUE" as const)
        : ("USER_DEFINED_VALUE" as const);
  const laneObject = await signedObject(
    13,
    new Map<number, CborValue>([
      [8, uuidToBytes(context.serverProfileId)],
      [11, uuidToBytes(context.teamId)],
      [13, uuidToBytes(context.projectId)],
      [14, uuidToBytes(context.environmentId)],
      [15, uuidToBytes(variable.id)],
      [16, uuidToBytes(input.revisionId)],
      [17, uuidToBytes(uuid())],
      [18, uuidToBytes(laneId)],
      ...(input.ownerUserId
        ? [[26, uuidToBytes(input.ownerUserId)] as const]
        : []),
      ...(input.originalProviderUserId
        ? [[27, uuidToBytes(input.originalProviderUserId)] as const]
        : []),
      [30, context.projectEpoch],
      [36, input.scope],
      [46, iv],
      [47, ciphertext],
      [48, ciphertextHash],
      [50, 1],
      [
        69,
        new Map<number, CborValue>([
          [44, salt],
          [45, ephemeralPublicKey],
        ]),
      ],
      [71, input.plaintext.length],
      [72, ciphertextLength],
    ]),
    context.signingPrivateKey,
  );
  const digest = await sha384(laneObject.bytes);
  return Object.freeze({
    lane: {
      id: laneId,
      protocolObjectId: laneId,
      scope: laneScope,
      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.originalProviderUserId
        ? { originalProviderUserId: input.originalProviderUserId }
        : {}),
      projectEpoch: context.projectEpoch,
      plaintextLength: input.plaintext.length,
      ciphertextLength,
      ciphertextHash: new Uint8Array(ciphertextHash),
    },
    commitment: {
      ordinal: 0,
      laneObjectId: laneId,
      objectHash: digest,
      projectEpoch: context.projectEpoch,
      scope: laneScope,
      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.originalProviderUserId
        ? { originalProviderUserId: input.originalProviderUserId }
        : {}),
      ciphertextLength,
    },
    staged: { objectId: laneId, bytes: laneObject.bytes },
    encryptedBytes: ciphertext.length,
  });
};

export const createPublicationArtifacts = async (
  variables: readonly PublicationVariable[],
  context: PublicationContext,
): Promise<PublicationArtifacts> => {
  const validationError = validatePublicationVariables(variables);
  if (validationError) throw new Error(validationError);
  const changed = variables.filter((variable) => variable.hasDraftChange);
  if (changed.length === 0) throw new Error("publication has no changed lanes");
  if (context.projectEpoch < 1)
    throw new Error("project epoch must be positive");
  if (context.mutation === "ROLLBACK" && !context.rollbackTargetId)
    throw new Error("rollback target revision is required");
  if (
    context.expectedHeadId !== null &&
    context.expectedHeadHash?.length !== 48
  )
    throw new Error("verified parent hash is required");
  if (context.expectedHeadId === null && context.expectedHeadHash !== null)
    throw new Error("an empty Environment cannot have a parent hash");

  const revisionId = uuid();
  const lanes: Array<FinalizePublicationRequest["lanes"][number]> = [];
  const commitments: Array<FinalizePublicationRequest["commitments"][number]> =
    [];
  const stagedObjects: StagedPublicationObject[] = [];
  const mutation = context.mutation ?? "MANIFEST_UPDATE";
  let encryptedBytes = 0;
  for (const variable of changed) {
    const includeDefinition =
      mutation !== "ROLLBACK" || variable.value === null;
    if (includeDefinition) {
      const definition = definitionPlaintext(variable);
      try {
        const definitionLane = await makeLane({
          context,
          variable,
          revisionId,
          scope: 2,
          plaintext: definition,
          recipientPublicKey: context.valueRecipientPublicKey,
        });
        lanes.push(definitionLane.lane);
        commitments.push({
          ...definitionLane.commitment,
          ordinal: commitments.length,
        });
        stagedObjects.push(definitionLane.staged);
        encryptedBytes += definitionLane.encryptedBytes;
      } finally {
        definition.fill(0);
      }
    }
    if (!variable.tombstone && variable.value !== null) {
      const value = new TextEncoder().encode(variable.value ?? "");
      try {
        const valueLane = await makeLane({
          context,
          variable,
          revisionId,
          scope: scopeValue(variable.ownership) as 3 | 4,
          plaintext: value,
          recipientPublicKey:
            variable.ownership === "USER_DEFINED_VALUE"
              ? (context.userDefinedValueRecipientPublicKey ??
                (() => {
                  throw new Error(
                    "User-defined Value recipient key is required",
                  );
                })())
              : context.valueRecipientPublicKey,
          ...(variable.ownership === "USER_DEFINED_VALUE"
            ? { ownerUserId: context.actorUserId }
            : { originalProviderUserId: context.actorUserId }),
        });
        lanes.push(valueLane.lane);
        commitments.push({
          ...valueLane.commitment,
          ordinal: commitments.length,
        });
        stagedObjects.push(valueLane.staged);
        encryptedBytes += valueLane.encryptedBytes;
      } finally {
        value.fill(0);
      }
    }
  }
  const laneCommitments = commitments.map(
    (commitment) =>
      new Map<number, CborValue>([
        [18, uuidToBytes(commitment.laneObjectId)],
        [36, scopeValueFromCommitment(commitment.scope)],
        [48, commitment.objectHash],
        [72, commitment.ciphertextLength],
        ...(commitment.ownerUserId
          ? [[26, uuidToBytes(commitment.ownerUserId)] as const]
          : []),
        ...(commitment.originalProviderUserId
          ? [[27, uuidToBytes(commitment.originalProviderUserId)] as const]
          : []),
      ]),
  );
  const descriptor = await signedObject(
    15,
    new Map<number, CborValue>([
      [8, uuidToBytes(context.serverProfileId)],
      [11, uuidToBytes(context.teamId)],
      [13, uuidToBytes(context.projectId)],
      [14, uuidToBytes(context.environmentId)],
      [16, uuidToBytes(revisionId)],
      [30, context.projectEpoch],
      [50, 1],
      [53, laneCommitments],
    ]),
    context.signingPrivateKey,
  );
  stagedObjects.push({ objectId: descriptor.id, bytes: descriptor.bytes });
  const descriptorHash = await sha384(descriptor.bytes);
  const mutationKind =
    mutation === "GENESIS" ? 1 : mutation === "ROLLBACK" ? 3 : 2;
  const rollbackFields: ReadonlyArray<readonly [number, CborValue]> =
    mutation === "ROLLBACK"
      ? [
          [21, uuidToBytes(context.rollbackTargetId ?? uuid())],
          [
            68,
            (
              context.rollbackSelectedVariableIds ??
              changed.map((variable) => variable.id)
            ).map(uuidToBytes),
          ],
        ]
      : [];
  const mutationInput = {
    context,
    revisionId,
    descriptorBytes: descriptor.bytes,
    descriptorHash,
    laneCommitments,
    changedVariableIds: changed.map((variable) => variable.id),
    mutationKind,
    rollbackFields,
    authoredAtMs: Date.now(),
  } as const;
  const revision = await signedObject(
    16,
    mutationFields(mutationInput),
    context.signingPrivateKey,
  );
  stagedObjects.push({ objectId: revision.id, bytes: revision.bytes });
  const command = revision;
  const request: FinalizePublicationRequest = {
    environmentId: context.environmentId,
    expectedHeadId: context.expectedHeadId,
    revision: {
      id: revisionId,
      protocolObjectId: revision.id,
      ...(context.expectedHeadHash
        ? { parentHash: context.expectedHeadHash }
        : {}),
      projectEpoch: context.projectEpoch,
      mutation,
      authoredAtMs: mutationInput.authoredAtMs,
      ...(context.rollbackTargetId
        ? { rollbackTargetId: context.rollbackTargetId }
        : {}),
    },
    descriptor: {
      protocolObjectId: descriptor.id,
      schemaVersion: 1,
      descriptorHash,
      laneCount: lanes.length,
    },
    lanes,
    commitments,
  };
  return Object.freeze({
    request,
    commandBytes: command.bytes,
    stagedObjects: Object.freeze(stagedObjects),
    encryptedLaneCount: lanes.length,
    encryptedBytes,
    tombstoneLaneCount: changed.filter((variable) => variable.tombstone).length,
    servicePlaintextBytes: 0,
  });
};

export const decodeSyncVariables = async (
  page: SyncPageWire,
  resolvePrivateKey: (
    scope: "SHARED_VALUE" | "USER_DEFINED_VALUE",
  ) => CryptoKey,
  existingVariables: readonly DecodedVariable[] = [],
): Promise<readonly DecodedVariable[]> => {
  const variables = new Map<
    string,
    {
      name: string;
      description: string;
      ownership: "SHARED_VALUE" | "USER_DEFINED_VALUE";
      value: string | null;
      required: boolean;
      tombstone: boolean;
    }
  >();
  for (const variable of existingVariables)
    variables.set(variable.id, {
      name: variable.name,
      description: variable.description,
      ownership: variable.ownership,
      value: variable.value,
      required: variable.required,
      tombstone: variable.tombstone,
    });
  for (const revision of page.revisions) {
    const laneObjects = revision.objects.filter((object) => {
      const lane = parseProtocolObject(object.canonicalBytes);
      return lane.get(1) === 13;
    });
    const orderedLaneObjects = [
      ...laneObjects.filter(
        (object) => parseProtocolObject(object.canonicalBytes).get(36) === 2,
      ),
      ...laneObjects.filter((object) => {
        const scope = parseProtocolObject(object.canonicalBytes).get(36);
        return scope === 3 || scope === 4;
      }),
    ];
    for (const object of orderedLaneObjects) {
      const lane = parseProtocolObject(object.canonicalBytes);
      if (lane.get(1) !== 13) continue;
      const variableId = lane.get(15);
      const scope = lane.get(36);
      if (!(variableId instanceof Uint8Array) || typeof scope !== "number")
        throw new ProtocolVerificationError("sync lane identity is malformed");
      const id = bytesToUuid(variableId);
      if (scope === 2) {
        const definition = JSON.parse(
          new TextDecoder().decode(
            await openLane(
              object.canonicalBytes,
              resolvePrivateKey("SHARED_VALUE"),
            ),
          ),
        ) as {
          name: string;
          description: string;
          ownership: "SHARED_VALUE" | "USER_DEFINED_VALUE";
          required: boolean;
          tombstone: boolean;
        };
        if (
          typeof definition.name !== "string" ||
          typeof definition.description !== "string" ||
          (definition.ownership !== "SHARED_VALUE" &&
            definition.ownership !== "USER_DEFINED_VALUE") ||
          typeof definition.required !== "boolean" ||
          typeof definition.tombstone !== "boolean"
        )
          throw new ProtocolVerificationError(
            "sync Variable definition is malformed",
          );
        const existing = variables.get(id);
        variables.set(id, {
          ...definition,
          value: definition.tombstone ? null : (existing?.value ?? null),
        });
      } else if (scope === 3 || scope === 4) {
        const existing = variables.get(id);
        if (!existing) continue;
        if (
          existing.tombstone ||
          (scope === 3 && existing.ownership !== "SHARED_VALUE") ||
          (scope === 4 && existing.ownership !== "USER_DEFINED_VALUE")
        )
          throw new ProtocolVerificationError(
            "sync Value lane ownership does not match its definition",
          );
        existing.value = new TextDecoder().decode(
          await openLane(
            object.canonicalBytes,
            resolvePrivateKey(
              scope === 3 ? "SHARED_VALUE" : "USER_DEFINED_VALUE",
            ),
          ),
        );
      }
    }
  }
  return Object.freeze(
    [...variables.entries()].map(([id, variable]) =>
      Object.freeze({ id, ...variable }),
    ),
  );
};

export const changedVariableIdsFromSyncPage = (
  page: SyncPageWire,
): ReadonlySet<string> => {
  const variableIds = new Set<string>();
  for (const revision of page.revisions) {
    const revisionObject = revision.objects.find((object) =>
      bytesEqual(object.digest, revision.digest),
    );
    if (!revisionObject)
      throw new ProtocolVerificationError(
        "sync page is missing the revision object",
      );
    const changed = parseProtocolObject(revisionObject.canonicalBytes).get(54);
    if (!Array.isArray(changed)) continue;
    for (const variableId of changed) {
      if (!(variableId instanceof Uint8Array) || variableId.length !== 16)
        throw new ProtocolVerificationError(
          "sync revision lane identity is malformed",
        );
      variableIds.add(bytesToUuid(variableId));
    }
  }
  return variableIds;
};

const scopeValueFromCommitment = (
  scope: FinalizePublicationRequest["commitments"][number]["scope"],
): number =>
  scope === "VARIABLE_DEFINITION"
    ? 2
    : scope === "SHARED_VALUE"
      ? 3
      : scope === "USER_DEFINED_VALUE"
        ? 4
        : 1;

export const verifySyncPage = async (
  page: SyncPageWire,
  signingPublicKey: Uint8Array,
  options: SyncDisclosureOptions = {},
): Promise<void> => {
  let environmentId: Uint8Array;
  let trustedRevisionId: Uint8Array;
  try {
    environmentId = uuidToBytes(page.environmentId);
    trustedRevisionId = uuidToBytes(page.trustedRevisionId);
  } catch {
    throw new ProtocolVerificationError("sync page identity is malformed");
  }
  if (page.trustedRevisionHash.length !== 48)
    throw new ProtocolVerificationError("trusted revision hash is malformed");
  let previousRevision: ProtocolObject | undefined;
  let previousRevisionDigest: Uint8Array | undefined;
  for (const [revisionIndex, revision] of page.revisions.entries()) {
    const revisionObject = revision.objects.find(
      (object) =>
        object.digest.length === 48 &&
        bytesEqual(object.digest, revision.digest),
    );
    if (!revisionObject)
      throw new ProtocolVerificationError(
        "sync page is missing the revision object",
      );
    const parsedRevision = parseProtocolObject(revisionObject.canonicalBytes);
    if (parsedRevision.get(1) !== 16)
      throw new ProtocolVerificationError(
        "sync page contains a non-revision object",
      );
    const revisionEnvironmentId = parsedRevision.get(14);
    const revisionId = parsedRevision.get(16);
    const revisionMutation = parsedRevision.get(35);
    const revisionEpoch = parsedRevision.get(30);
    const revisionAuthoredAt = parsedRevision.get(34);
    if (
      !(revisionEnvironmentId instanceof Uint8Array) ||
      !bytesEqual(revisionEnvironmentId, environmentId) ||
      !(revisionId instanceof Uint8Array) ||
      bytesToUuid(revisionId) !== revision.id ||
      typeof revisionMutation !== "number" ||
      revisionMutation !== revision.mutation ||
      (typeof revisionEpoch !== "number" &&
        typeof revisionEpoch !== "bigint") ||
      BigInt(revisionEpoch as number | bigint) !== revision.projectEpoch ||
      (typeof revisionAuthoredAt !== "number" &&
        typeof revisionAuthoredAt !== "bigint") ||
      BigInt(revisionAuthoredAt as number | bigint) !== revision.authoredAtMs
    )
      throw new ProtocolVerificationError("sync revision identity mismatch");
    const actualRevisionDigest = await sha384(revisionObject.canonicalBytes);
    if (!bytesEqual(actualRevisionDigest, revision.digest))
      throw new ProtocolVerificationError("revision digest mismatch");
    await verifySignedProtocolObject(
      revisionObject.canonicalBytes,
      signingPublicKey,
    );
    if (revision.parentId !== null) {
      const parentId = parsedRevision.get(19);
      const parentHash = parsedRevision.get(20);
      if (
        !(parentId instanceof Uint8Array) ||
        bytesToUuid(parentId) !== revision.parentId ||
        !(parentHash instanceof Uint8Array) ||
        !bytesEqual(parentHash, revision.parentHash ?? new Uint8Array(48))
      )
        throw new ProtocolVerificationError(
          "sync revision parent metadata does not match",
        );
    }
    if (revision.rollbackTargetId !== null) {
      const rollbackTargetId = parsedRevision.get(21);
      if (
        !(rollbackTargetId instanceof Uint8Array) ||
        bytesToUuid(rollbackTargetId) !== revision.rollbackTargetId
      )
        throw new ProtocolVerificationError(
          "sync rollback metadata does not match",
        );
    }
    if (previousRevision) {
      const parentId = parsedRevision.get(19);
      const parentHash = parsedRevision.get(20);
      const previousId = previousRevision.get(16);
      if (
        !(parentId instanceof Uint8Array) ||
        !(parentHash instanceof Uint8Array) ||
        !(previousId instanceof Uint8Array) ||
        !previousRevisionDigest ||
        !bytesEqual(parentId, previousId) ||
        !bytesEqual(parentHash, previousRevisionDigest)
      )
        throw new ProtocolVerificationError("revision chain link mismatch");
    } else {
      const parentId = parsedRevision.get(19);
      const parentHash = parsedRevision.get(20);
      if (
        !(parentId instanceof Uint8Array) ||
        !(parentHash instanceof Uint8Array) ||
        !bytesEqual(parentId, trustedRevisionId) ||
        !bytesEqual(parentHash, page.trustedRevisionHash)
      )
        throw new ProtocolVerificationError(
          "sync page does not continue from the trusted head",
        );
    }
    const manifestDescriptor = parsedRevision.get(51);
    const manifestHash = parsedRevision.get(52);
    if (
      !(manifestDescriptor instanceof Uint8Array) ||
      !(manifestHash instanceof Uint8Array) ||
      !bytesEqual(await sha384(manifestDescriptor), manifestHash)
    )
      throw new ProtocolVerificationError("manifest hash mismatch");
    const descriptorObject = revision.objects.find((object) =>
      bytesEqual(object.digest, manifestHash),
    );
    if (
      !descriptorObject ||
      !bytesEqual(descriptorObject.canonicalBytes, manifestDescriptor) ||
      parseProtocolObject(descriptorObject.canonicalBytes).get(1) !== 15
    )
      throw new ProtocolVerificationError(
        "sync page is missing the manifest descriptor",
      );
    const revisionCommitments = parsedRevision.get(53);
    const descriptorCommitments = parseProtocolObject(
      descriptorObject.canonicalBytes,
    ).get(53);
    if (
      !Array.isArray(revisionCommitments) ||
      !Array.isArray(descriptorCommitments) ||
      !bytesEqual(
        canonicalEncode(revisionCommitments),
        canonicalEncode(descriptorCommitments),
      )
    )
      throw new ProtocolVerificationError(
        "sync manifest commitments do not match",
      );
    const commitments = revisionCommitments.filter(
      (commitment): commitment is Map<number, CborValue> =>
        commitment instanceof Map,
    );
    const disclosedLaneIds = new Set<string>();
    for (const object of revision.objects) {
      const digest = await sha384(object.canonicalBytes);
      if (!bytesEqual(digest, object.digest))
        throw new ProtocolVerificationError("sync object digest mismatch");
      const parsed = parseProtocolObject(object.canonicalBytes);
      if ([13, 15, 16].includes(parsed.get(1) as number))
        await verifySignedProtocolObject(
          object.canonicalBytes,
          signingPublicKey,
        );
      const objectEnvironmentId = parsed.get(14);
      if (
        !(objectEnvironmentId instanceof Uint8Array) ||
        !bytesEqual(objectEnvironmentId, environmentId)
      )
        throw new ProtocolVerificationError(
          "sync object environment identity mismatch",
        );
      if (parsed.get(1) === 13) {
        const laneId = parsed.get(18);
        const laneScope = parsed.get(36);
        const laneCiphertextLength = parsed.get(72);
        const commitment = commitments.find((candidate) => {
          const candidateLaneId = candidate.get(18);
          return (
            candidateLaneId instanceof Uint8Array &&
            laneId instanceof Uint8Array &&
            bytesEqual(candidateLaneId, laneId)
          );
        });
        if (
          !(laneId instanceof Uint8Array) ||
          typeof laneScope !== "number" ||
          typeof laneCiphertextLength !== "number" ||
          !commitment ||
          !(commitment.get(48) instanceof Uint8Array) ||
          !(commitment.get(36) === laneScope) ||
          commitment.get(72) !== laneCiphertextLength ||
          !bytesEqual(commitment.get(48) as Uint8Array, object.digest)
        )
          throw new ProtocolVerificationError(
            "sync lane is not covered by a manifest commitment",
          );
        disclosedLaneIds.add(bytesToUuid(laneId));
        const ciphertext = parsed.get(47);
        const ciphertextHash = parsed.get(48);
        if (
          !(ciphertext instanceof Uint8Array) ||
          !(ciphertextHash instanceof Uint8Array) ||
          !bytesEqual(await sha384(ciphertext), ciphertextHash)
        )
          throw new ProtocolVerificationError(
            "lane ciphertext digest mismatch",
          );
      }
    }
    for (const commitment of commitments) {
      const laneId = commitment.get(18);
      const scope = commitment.get(36);
      const owner = commitment.get(26);
      if (!(laneId instanceof Uint8Array) || typeof scope !== "number")
        throw new ProtocolVerificationError(
          "sync commitment identity is malformed",
        );
      if (disclosedLaneIds.has(bytesToUuid(laneId))) continue;
      const ownerId = owner instanceof Uint8Array ? bytesToUuid(owner) : null;
      const allowedOmission =
        scope === 4 &&
        ownerId !== null &&
        options.actorUserId !== undefined &&
        ownerId !== options.actorUserId;
      if (!allowedOmission)
        throw new ProtocolVerificationError(
          "sync page omitted an authorized lane",
        );
    }
    previousRevision = parsedRevision;
    previousRevisionDigest = revision.digest;
    if (
      revisionIndex === page.revisions.length - 1 &&
      page.nextCursor === null &&
      (page.currentHeadId !== revision.id ||
        !page.currentHeadHash ||
        !bytesEqual(page.currentHeadHash, revision.digest))
    )
      throw new ProtocolVerificationError(
        "sync page current head does not match its final revision",
      );
  }
  if (
    page.revisions.length === 0 &&
    page.nextCursor === null &&
    !(
      page.currentHeadId === page.trustedRevisionId &&
      page.currentHeadHash &&
      bytesEqual(page.currentHeadHash, page.trustedRevisionHash)
    ) &&
    !(
      page.trustedRevisionId === page.environmentId &&
      page.currentHeadId === null &&
      page.currentHeadHash === null &&
      page.trustedRevisionHash.length === 48 &&
      page.trustedRevisionHash.every((byte) => byte === 0)
    )
  )
    throw new ProtocolVerificationError(
      "sync page current head does not match the trusted head",
    );
};

export const openLane = async (
  laneBytes: Uint8Array,
  recipientPrivateKey: CryptoKey,
): Promise<Uint8Array> => {
  const lane = parseProtocolObject(laneBytes);
  if (lane.get(1) !== 13)
    throw new TypeError("expected ciphertext lane object");
  const routing = lane.get(69);
  const salt = routing instanceof Map ? routing.get(44) : undefined;
  const ephemeralPublicKey =
    routing instanceof Map ? routing.get(45) : undefined;
  const iv = lane.get(46);
  const ciphertext = lane.get(47);
  const ciphertextHash = lane.get(48);
  const plaintextLength = lane.get(71);
  const ciphertextLength = lane.get(72);
  if (
    !(salt instanceof Uint8Array) ||
    !(ephemeralPublicKey instanceof Uint8Array) ||
    !(iv instanceof Uint8Array) ||
    !(ciphertext instanceof Uint8Array) ||
    !(ciphertextHash instanceof Uint8Array) ||
    typeof plaintextLength !== "number" ||
    typeof ciphertextLength !== "number"
  )
    throw new TypeError("ciphertext lane envelope metadata is missing");
  const variableId = lane.get(15);
  const revisionId = lane.get(16);
  const scope = lane.get(36);
  if (
    !(variableId instanceof Uint8Array) ||
    !(revisionId instanceof Uint8Array) ||
    typeof scope !== "number"
  )
    throw new TypeError("ciphertext lane identity is missing");
  const envelope = new Map<number, CborValue>([
    [0, SUITE_VALUE],
    [44, salt],
    [45, ephemeralPublicKey],
    [46, iv],
    [47, ciphertext],
    [48, ciphertextHash],
    [71, plaintextLength],
    [72, ciphertextLength],
  ]);
  return open(
    canonicalEncode(envelope),
    recipientPrivateKey,
    canonicalEncode(
      new Map<number, CborValue>([
        [15, variableId],
        [16, revisionId],
        [36, scope],
      ]),
    ),
  );
};
