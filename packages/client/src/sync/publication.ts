import {
  bytesToUuid,
  type CborValue,
  canonicalEncode,
  decodeCiphertextEnvelope,
  encodeProtocolObject,
  type FinalizePublicationRequest,
  InvalidCiphertextError,
  open,
  openWithSharedSecret,
  type ProtocolObject,
  parseProtocolObject,
  protocolObjectFromFields,
  SUITE_VALUE,
  type SyncPageWire,
  type SyncRevisionWire,
  seal,
  sealWithSharedSecret,
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

export type PublicationMutationKind =
  | "GENESIS"
  | "MANIFEST_UPDATE"
  | "ROLLBACK";

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
  readonly sharedValueSecret?: Uint8Array;
  // The User Value Key opened from the owner's Account Key Envelope. It seals
  // User-defined Values for every Device that can recover the Account Master
  // Key. Team-shared Values keep using sharedValueSecret.
  readonly userDefinedValueSecret?: Uint8Array;
  readonly signingPrivateKey: CryptoKey;
  readonly revisionSigningPublicKey?: Uint8Array;
  readonly trustedRevisionId?: string;
  readonly trustedRevisionHash?: Uint8Array;
  readonly mutation?: PublicationMutationKind;
  readonly rollbackTargetId?: string;
  readonly rollbackSelectedVariableIds?: readonly string[];
}>;

export type SyncDisclosureOptions = Readonly<{
  readonly actorUserId?: string;
}>;

export type RevisionSigningTrustEntry = Readonly<{
  readonly publicKey: Uint8Array;
  readonly deviceId?: string;
  readonly userId?: string;
  /** When this Device became authorized to sign (Unix milliseconds); null if it never was. */
  readonly deviceActiveFromMs?: number | null;
  /** When this Device was revoked (Unix milliseconds); null if it was never revoked. */
  readonly deviceActiveUntilMs?: number | null;
  /** When the author's Membership became active (Unix milliseconds); null if it never was. */
  readonly memberSinceMs?: number | null;
  /** When the author's Membership was removed (Unix milliseconds); null while still a Member. */
  readonly memberUntilMs?: number | null;
}>;

export type RevisionSigningTrust =
  | Uint8Array
  | readonly Uint8Array[]
  | readonly RevisionSigningTrustEntry[];

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
  readonly originalProviderUserId?: string | null;
  readonly ownerUserId?: string | null;
}>;

export type UnreadableLaneKind =
  | "VARIABLE_DEFINITION"
  | "SHARED_VALUE"
  | "USER_DEFINED_VALUE";

/**
 * A lane the verified page covers but this Device cannot decrypt: the
 * Variable's definition, a Shared Value, or a User-defined Value the actor
 * owns (or whose owner cannot be established). Callers must stop exporting
 * or publishing instead of falling back to an empty or earlier Value.
 */
export class UnreadableLaneError extends Error {
  readonly variableId: string;
  readonly laneKind: UnreadableLaneKind;
  readonly ownerUserId: string | null;

  constructor(
    input: Readonly<{
      readonly variableId: string;
      readonly laneKind: UnreadableLaneKind;
      readonly ownerUserId?: string | null;
    }>,
  ) {
    super(
      input.laneKind === "VARIABLE_DEFINITION"
        ? `Variable ${input.variableId}: its definition cannot be decrypted with this Device's Project key grant`
        : input.laneKind === "SHARED_VALUE"
          ? `Variable ${input.variableId}: its Shared Value cannot be decrypted with this Device's Project key grant`
          : `Variable ${input.variableId}: its User-defined Value cannot be decrypted with this Device's key grant`,
    );
    this.name = "UnreadableLaneError";
    this.variableId = input.variableId;
    this.laneKind = input.laneKind;
    this.ownerUserId = input.ownerUserId ?? null;
  }
}

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
    readonly sharedSecret?: Uint8Array;
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
  const envelopeBytes = input.sharedSecret
    ? await sealWithSharedSecret(
        input.plaintext,
        input.sharedSecret,
        associatedData(variable.id, input.revisionId, input.scope),
      )
    : await seal(
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
  if (context.mutation === "GENESIS" && context.expectedHeadId !== null)
    throw new Error("GENESIS requires an empty Environment head");
  if (context.mutation === "MANIFEST_UPDATE" && context.expectedHeadId === null)
    throw new Error("MANIFEST_UPDATE requires a non-empty Environment head");

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
          ...(context.sharedValueSecret
            ? { sharedSecret: context.sharedValueSecret }
            : {}),
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
          ...(variable.ownership === "SHARED_VALUE" && context.sharedValueSecret
            ? { sharedSecret: context.sharedValueSecret }
            : {}),
          ...(variable.ownership === "USER_DEFINED_VALUE" &&
          context.userDefinedValueSecret
            ? { sharedSecret: context.userDefinedValueSecret }
            : {}),
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

const laneUserId = (lane: ProtocolObject, field: 26 | 27): string | null => {
  const value = lane.get(field);
  if (!(value instanceof Uint8Array) || value.length !== 16) return null;
  return bytesToUuid(value);
};

const commitmentUserId = (
  commitment: Map<number, CborValue>,
  field: 26 | 27,
): string | null => {
  const value = commitment.get(field);
  if (!(value instanceof Uint8Array) || value.length !== 16) return null;
  return bytesToUuid(value);
};

type DecodedVariableState = {
  name: string;
  description: string;
  ownership: "SHARED_VALUE" | "USER_DEFINED_VALUE";
  value: string | null;
  required: boolean;
  tombstone: boolean;
  originalProviderUserId: string | null;
  ownerUserId: string | null;
};

// How the newest lane of one kind for a Variable decoded: READ means the
// head state is verified, REQUIRED_UNREADABLE means this Device must be able
// to read it and cannot, and OTHER_UNREADABLE means a User-defined Value
// another User owns withheld it from this Device.
type LaneReadState = "READ" | "REQUIRED_UNREADABLE" | "OTHER_UNREADABLE";

type ValueLaneState = Readonly<{
  readonly state: LaneReadState;
  readonly scope: 3 | 4;
  readonly ownerUserId: string | null;
}>;

export type SyncManifestDecode = Readonly<{
  /** The Manifest at the page's final Revision. */
  readonly variables: readonly DecodedVariable[];
  /**
   * The decoded Manifest at each Revision of the page, in page order; a
   * Value this Device cannot read is null, never an earlier Value.
   */
  readonly snapshots: ReadonlyMap<string, readonly DecodedVariable[]>;
}>;

const decodedVariables = (
  variables: ReadonlyMap<string, DecodedVariableState>,
): readonly DecodedVariable[] =>
  Object.freeze(
    [...variables.entries()].map(([id, variable]) =>
      Object.freeze({ id, ...variable }),
    ),
  );

/**
 * Decodes the Variables a verified sync page proves, folding each Revision
 * over `existingVariables`, and records the Manifest at every Revision.
 * The caller must verify the page (verifySyncPage) first so only service-
 * disclosed lanes are decoded.
 *
 * At the head Revision, a lane this Device cannot decrypt fails the decode
 * with UnreadableLaneError instead of yielding an empty Manifest or
 * presenting an earlier Value as current: Variable definitions and Shared
 * Values every Member must read, and User-defined Values the `actorUserId`
 * owns (or whose owner cannot be established). A lane an earlier Revision
 * sealed unreadably does not fail the decode when a later Revision
 * re-publishes it readably: only the head state must be verified. A User-defined Value another User owns is legitimately
 * undisclosed to this Device: it stays null rather than a stale earlier
 * Value, whether the lane is disclosed but unreadable or omitted from the
 * page.
 */
export const decodeSyncManifest = async (
  page: SyncPageWire,
  resolvePrivateKey: (
    scope: "SHARED_VALUE" | "USER_DEFINED_VALUE",
  ) => CryptoKey,
  existingVariables: readonly DecodedVariable[] = [],
  sharedValueSecret?: Uint8Array,
  actorUserId?: string,
  userDefinedValueSecret?: Uint8Array,
): Promise<SyncManifestDecode> => {
  const variables = new Map<string, DecodedVariableState>();
  for (const variable of existingVariables)
    variables.set(variable.id, {
      name: variable.name,
      description: variable.description,
      ownership: variable.ownership,
      value: variable.value,
      required: variable.required,
      tombstone: variable.tombstone,
      originalProviderUserId: variable.originalProviderUserId ?? null,
      ownerUserId: variable.ownerUserId ?? null,
    });
  // Newest lane state per Variable, so a Revision that re-publishes a lane
  // readably clears an earlier Revision's unreadable one.
  const definitionStates = new Map<string, LaneReadState>();
  const valueStates = new Map<string, ValueLaneState>();
  const snapshots = new Map<string, readonly DecodedVariable[]>();
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
    const disclosedValueLaneVariableIds = new Set<string>();
    for (const object of orderedLaneObjects) {
      const lane = parseProtocolObject(object.canonicalBytes);
      if (lane.get(1) !== 13) continue;
      const variableId = lane.get(15);
      const scope = lane.get(36);
      if (!(variableId instanceof Uint8Array) || typeof scope !== "number")
        throw new ProtocolVerificationError("sync lane identity is malformed");
      const id = bytesToUuid(variableId);
      if (scope === 2) {
        const plaintext = await openReadableLane(
          object.canonicalBytes,
          resolvePrivateKey("SHARED_VALUE"),
          sharedValueSecret,
        );
        if (!plaintext) {
          // The head definition of this Variable is unverified; whether that
          // fails the decode is decided once the whole page is folded.
          definitionStates.set(id, "REQUIRED_UNREADABLE");
          continue;
        }
        definitionStates.set(id, "READ");
        const definition = JSON.parse(new TextDecoder().decode(plaintext)) as {
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
          originalProviderUserId: definition.tombstone
            ? null
            : (existing?.originalProviderUserId ?? null),
          ownerUserId: definition.tombstone
            ? null
            : (existing?.ownerUserId ?? null),
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
        if (scope === 3) {
          existing.originalProviderUserId ??= laneUserId(lane, 27);
          existing.ownerUserId = null;
        } else {
          existing.ownerUserId = laneUserId(lane, 26);
          existing.originalProviderUserId = null;
        }
        disclosedValueLaneVariableIds.add(id);
        const plaintext = await openReadableLane(
          object.canonicalBytes,
          resolvePrivateKey(
            scope === 3 ? "SHARED_VALUE" : "USER_DEFINED_VALUE",
          ),
          scope === 3 ? sharedValueSecret : userDefinedValueSecret,
        );
        if (!plaintext) {
          // Never carry an earlier Value across a lane this Device cannot
          // verify: until a later Revision re-publishes it readably the
          // Value is unknown.
          existing.value = null;
          const ownerUserId = existing.ownerUserId;
          const otherUserValue =
            scope === 4 &&
            ownerUserId !== null &&
            (actorUserId === undefined || ownerUserId !== actorUserId);
          if (otherUserValue) {
            valueStates.set(id, {
              state: "OTHER_UNREADABLE",
              scope: 4,
              ownerUserId,
            });
          } else {
            valueStates.set(id, {
              state: "REQUIRED_UNREADABLE",
              scope,
              ownerUserId: scope === 4 ? ownerUserId : null,
            });
          }
        } else {
          valueStates.set(id, {
            state: "READ",
            scope,
            ownerUserId: scope === 4 ? existing.ownerUserId : null,
          });
          existing.value = new TextDecoder().decode(plaintext);
        }
      }
    }
    // The page may omit a lane only when it holds another User's
    // User-defined Value (verifySyncPage enforces this); the descriptor's
    // commitments name the omitted lane but not its Variable, so the
    // Variable is only attributable when the Revision changed exactly the
    // Variables that lack a disclosed Value lane.
    const descriptorObject = revision.objects.find((object) => {
      const object_ = parseProtocolObject(object.canonicalBytes);
      return object_.get(1) === 15;
    });
    const hiddenOtherUserValueLaneOwners: string[] = [];
    if (descriptorObject) {
      const commitments = parseProtocolObject(
        descriptorObject.canonicalBytes,
      ).get(53);
      const disclosedLaneIds = new Set<string>();
      for (const object of laneObjects) {
        const lane = parseProtocolObject(object.canonicalBytes);
        const laneId = lane.get(18);
        if (laneId instanceof Uint8Array && laneId.length === 16)
          disclosedLaneIds.add(bytesToUuid(laneId));
      }
      if (Array.isArray(commitments)) {
        for (const commitment of commitments) {
          if (!(commitment instanceof Map)) continue;
          const laneId = commitment.get(18);
          if (
            !(laneId instanceof Uint8Array) ||
            laneId.length !== 16 ||
            disclosedLaneIds.has(bytesToUuid(laneId))
          )
            continue;
          const scope = commitment.get(36);
          const ownerId = commitmentUserId(commitment, 26);
          if (
            scope === 4 &&
            ownerId !== null &&
            (actorUserId === undefined || ownerId !== actorUserId)
          )
            hiddenOtherUserValueLaneOwners.push(ownerId);
        }
      }
    }
    if (hiddenOtherUserValueLaneOwners.length > 0) {
      let changedVariableIds: ReadonlySet<string> = new Set([
        ...disclosedValueLaneVariableIds,
      ]);
      try {
        changedVariableIds = changedVariableIdsFromRevision(revision);
      } catch {
        // A page that cannot name the changed Variables cannot attribute an
        // omitted lane, so the Value states stay as the lanes recorded them.
      }
      const candidates = [...changedVariableIds].filter((id) => {
        const candidate = variables.get(id);
        return (
          candidate !== undefined &&
          !candidate.tombstone &&
          candidate.ownership === "USER_DEFINED_VALUE" &&
          !disclosedValueLaneVariableIds.has(id)
        );
      });
      if (candidates.length === hiddenOtherUserValueLaneOwners.length) {
        // The commitments name each omitted lane's owner, though not its
        // Variable; when every omitted lane has one owner the head state can
        // attribute it so the UI can say whose Value is withheld.
        const owners = new Set(hiddenOtherUserValueLaneOwners);
        const owner = owners.size === 1 ? ([...owners][0] ?? null) : null;
        for (const id of candidates) {
          const candidate = variables.get(id);
          if (!candidate) continue;
          candidate.value = null;
          if (owner !== null) candidate.ownerUserId = owner;
          valueStates.set(id, {
            state: "OTHER_UNREADABLE",
            scope: 4,
            ownerUserId: candidate.ownerUserId,
          });
        }
      }
    }
    snapshots.set(revision.id, decodedVariables(variables));
  }
  for (const [id, state] of definitionStates)
    if (state === "REQUIRED_UNREADABLE")
      throw new UnreadableLaneError({
        variableId: id,
        laneKind: "VARIABLE_DEFINITION",
      });
  for (const [id, state] of valueStates)
    if (state.state === "REQUIRED_UNREADABLE")
      throw new UnreadableLaneError({
        variableId: id,
        laneKind: state.scope === 3 ? "SHARED_VALUE" : "USER_DEFINED_VALUE",
        ownerUserId: state.ownerUserId,
      });
  return Object.freeze({
    variables: decodedVariables(variables),
    snapshots,
  });
};

/**
 * Decodes the Manifest at the head Revision of a verified sync page. A
 * required lane this Device cannot decrypt rejects with UnreadableLaneError
 * instead of returning an empty Manifest or presenting an earlier Value as
 * current; see decodeSyncManifest for the full contract.
 */
export const decodeSyncVariables = async (
  page: SyncPageWire,
  resolvePrivateKey: (
    scope: "SHARED_VALUE" | "USER_DEFINED_VALUE",
  ) => CryptoKey,
  existingVariables: readonly DecodedVariable[] = [],
  sharedValueSecret?: Uint8Array,
  actorUserId?: string,
  userDefinedValueSecret?: Uint8Array,
): Promise<readonly DecodedVariable[]> =>
  (
    await decodeSyncManifest(
      page,
      resolvePrivateKey,
      existingVariables,
      sharedValueSecret,
      actorUserId,
      userDefinedValueSecret,
    )
  ).variables;

export const changedVariableIdsFromRevision = (
  revision: SyncRevisionWire,
): ReadonlySet<string> => {
  const revisionObject = revision.objects.find((object) =>
    bytesEqual(object.digest, revision.digest),
  );
  if (!revisionObject)
    throw new ProtocolVerificationError(
      "sync page is missing the revision object",
    );
  const changed = parseProtocolObject(revisionObject.canonicalBytes).get(54);
  const variableIds = new Set<string>();
  if (!Array.isArray(changed)) return variableIds;
  for (const variableId of changed) {
    if (!(variableId instanceof Uint8Array) || variableId.length !== 16)
      throw new ProtocolVerificationError(
        "sync revision lane identity is malformed",
      );
    variableIds.add(bytesToUuid(variableId));
  }
  return variableIds;
};

export const changedVariableIdsFromSyncPage = (
  page: SyncPageWire,
): ReadonlySet<string> => {
  const variableIds = new Set<string>();
  for (const revision of page.revisions) {
    for (const variableId of changedVariableIdsFromRevision(revision))
      variableIds.add(variableId);
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

const verifySignedProtocolObjectWithKeys = async (
  canonicalBytes: Uint8Array,
  keys: readonly Uint8Array[],
): Promise<void> => {
  if (keys.length === 0)
    throw new ProtocolVerificationError("sync object signature is invalid");
  let lastError: unknown;
  for (const key of keys) {
    try {
      await verifySignedProtocolObject(canonicalBytes, key);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof ProtocolVerificationError) throw lastError;
  throw new ProtocolVerificationError("sync object signature is invalid");
};

type SigningTrustEntry = Readonly<{
  readonly publicKey: Uint8Array;
  readonly constrained: boolean;
  readonly deviceId?: string;
  readonly userId?: string;
  readonly deviceActiveFromMs?: number | null;
  readonly deviceActiveUntilMs?: number | null;
  readonly memberSinceMs?: number | null;
  readonly memberUntilMs?: number | null;
}>;

const normalizeSigningTrust = (
  trust: RevisionSigningTrust,
): SigningTrustEntry[] => {
  if (trust instanceof Uint8Array)
    return [{ publicKey: trust, constrained: false }];
  if (!Array.isArray(trust))
    throw new ProtocolVerificationError("signing trust is malformed");
  return trust.map((item): SigningTrustEntry => {
    if (item instanceof Uint8Array)
      return { publicKey: item, constrained: false };
    if (typeof item !== "object" || item === null)
      throw new ProtocolVerificationError("signing trust entry is malformed");
    if (!(item.publicKey instanceof Uint8Array))
      throw new ProtocolVerificationError("signing trust entry is malformed");
    const constrained =
      item.deviceId !== undefined ||
      item.userId !== undefined ||
      item.deviceActiveFromMs !== undefined ||
      item.deviceActiveUntilMs !== undefined ||
      item.memberSinceMs !== undefined ||
      item.memberUntilMs !== undefined;
    return {
      publicKey: item.publicKey,
      constrained,
      ...(item.deviceId !== undefined ? { deviceId: item.deviceId } : {}),
      ...(item.userId !== undefined ? { userId: item.userId } : {}),
      ...(item.deviceActiveFromMs !== undefined
        ? { deviceActiveFromMs: item.deviceActiveFromMs }
        : {}),
      ...(item.deviceActiveUntilMs !== undefined
        ? { deviceActiveUntilMs: item.deviceActiveUntilMs }
        : {}),
      ...(item.memberSinceMs !== undefined
        ? { memberSinceMs: item.memberSinceMs }
        : {}),
      ...(item.memberUntilMs !== undefined
        ? { memberUntilMs: item.memberUntilMs }
        : {}),
    };
  });
};

// One half of a Device or Membership window: a `null` start means the
// interval never opened (the Device or Membership never became active), an
// absent bound means it is still open.
const windowAdmits = (
  fromMs: number | null | undefined,
  untilMs: number | null | undefined,
  authoredAtMs: bigint,
): boolean => {
  if (fromMs === null) return false;
  if (typeof fromMs === "number" && authoredAtMs < BigInt(fromMs)) return false;
  return !(typeof untilMs === "number" && authoredAtMs >= BigInt(untilMs));
};

// A Revision authorizes through an entry only when the entry's Device and
// Membership were both authorized at the Revision's authored-at instant, so a
// Device revoked after a legitimate Revision keep it verifiable while writes
// made after the revocation stay rejected.
const entryAuthorizesRevision = (
  entry: SigningTrustEntry,
  signingDeviceId: unknown,
  authorUserId: unknown,
  authoredAtMs: bigint,
): boolean => {
  if (
    !windowAdmits(
      entry.deviceActiveFromMs,
      entry.deviceActiveUntilMs,
      authoredAtMs,
    ) ||
    !windowAdmits(entry.memberSinceMs, entry.memberUntilMs, authoredAtMs)
  )
    return false;
  if (entry.deviceId !== undefined) {
    if (
      !(signingDeviceId instanceof Uint8Array) ||
      signingDeviceId.length !== 16
    )
      return false;
    if (bytesToUuid(signingDeviceId) !== entry.deviceId) return false;
  }
  if (entry.userId !== undefined) {
    if (!(authorUserId instanceof Uint8Array) || authorUserId.length !== 16)
      return false;
    if (bytesToUuid(authorUserId) !== entry.userId) return false;
  }
  return true;
};

const authorizeRevisionSignature = async (
  canonicalBytes: Uint8Array,
  entries: readonly SigningTrustEntry[],
  parsedRevision: ProtocolObject,
  authoredAtMs: bigint,
): Promise<Uint8Array[]> => {
  const signingDeviceId = parsedRevision.get(23);
  const authorUserId = parsedRevision.get(22);
  const authorizing: Uint8Array[] = [];
  let lastError: unknown;
  for (const entry of entries) {
    if (
      !entryAuthorizesRevision(
        entry,
        signingDeviceId,
        authorUserId,
        authoredAtMs,
      )
    )
      continue;
    try {
      await verifySignedProtocolObject(canonicalBytes, entry.publicKey);
      authorizing.push(entry.publicKey);
    } catch (error) {
      lastError = error;
    }
  }
  if (authorizing.length > 0) return authorizing;
  if (lastError instanceof ProtocolVerificationError) throw lastError;
  throw new ProtocolVerificationError(
    "sync revision signature is not authorized",
  );
};

export const verifySyncPage = async (
  page: SyncPageWire,
  signingTrust: RevisionSigningTrust,
  options: SyncDisclosureOptions = {},
): Promise<void> => {
  const trustEntries = normalizeSigningTrust(signingTrust);
  const trustKeys = trustEntries.map((entry) => entry.publicKey);
  const scopedTrust = trustEntries.some((entry) => entry.constrained);
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
    let revisionTrustKeys = trustKeys;
    if (scopedTrust) {
      revisionTrustKeys = await authorizeRevisionSignature(
        revisionObject.canonicalBytes,
        trustEntries,
        parsedRevision,
        revision.authoredAtMs,
      );
    } else {
      await verifySignedProtocolObjectWithKeys(
        revisionObject.canonicalBytes,
        trustKeys,
      );
    }
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
        await verifySignedProtocolObjectWithKeys(
          object.canonicalBytes,
          revisionTrustKeys,
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

const openReadableLane = async (
  laneBytes: Uint8Array,
  recipientPrivateKey: CryptoKey,
  sharedValueSecret?: Uint8Array,
): Promise<Uint8Array | null> => {
  try {
    return await openLane(laneBytes, recipientPrivateKey, sharedValueSecret);
  } catch (error) {
    if (error instanceof InvalidCiphertextError) return null;
    throw error;
  }
};

export const openLane = async (
  laneBytes: Uint8Array,
  recipientPrivateKey: CryptoKey,
  sharedValueSecret?: Uint8Array,
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
  const associated = canonicalEncode(
    new Map<number, CborValue>([
      [15, variableId],
      [16, revisionId],
      [36, scope],
    ]),
  );
  const encoded = canonicalEncode(envelope);
  try {
    return await open(encoded, recipientPrivateKey, associated);
  } catch (error) {
    if (!sharedValueSecret || !(error instanceof InvalidCiphertextError))
      throw error;
    return openWithSharedSecret(encoded, sharedValueSecret, associated);
  }
};
