import {
  bytesToUuid,
  type CborValue,
  canonicalEncode,
  checkRevisionAuthoredAt,
  chooseRevisionAuthoredAtMs,
  decodeCiphertextEnvelope,
  encodeProtocolObject,
  type FinalizePublicationRequest,
  InvalidCiphertextError,
  LANE_FORMAT_CONTEXT_BOUND,
  LANE_FORMAT_LEGACY,
  LANE_FORMATS,
  laneAssociatedData,
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
  "GENESIS" | "MANIFEST_UPDATE" | "ROLLBACK";

export type PublicationContext = Readonly<{
  readonly serverProfileId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly projectEpoch: number;
  /**
   * The Project epoch of the verified parent Revision. A publication never
   * seals Values under an epoch older than the head it builds on: after a
   * rotation that would hand them to whoever still holds the old key.
   */
  readonly parentProjectEpoch?: number;
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
  /**
   * The earliest authored-at instant the service and every verifying client
   * accept for this Revision: the latest of this Device's activation, the
   * author's Membership activation, and the parent Revision's authored-at
   * instant (see `revisionAuthoredAtNotBeforeMs`). A slow local clock is
   * raised to it instead of producing a Revision nobody can verify.
   */
  readonly authoredAtNotBeforeMs?: number;
  /** This Device's clock; defaults to Date.now(). */
  readonly nowMs?: number;
}>;

/**
 * The not-before floor for a new Revision's authored-at instant, from what
 * the client already knows: its own Device activation and Membership
 * activation (the boundary's signing trust entry for this Device), and the
 * parent Revision's authored-at instant. Absent inputs are ignored.
 */
export const revisionAuthoredAtNotBeforeMs = (
  input: Readonly<{
    readonly deviceActiveFromMs?: number | null;
    readonly memberSinceMs?: number | null;
    readonly parentAuthoredAtMs?: number | bigint | null;
  }>,
): number | undefined => {
  const candidates = [
    input.deviceActiveFromMs,
    input.memberSinceMs,
    typeof input.parentAuthoredAtMs === "bigint"
      ? Number(input.parentAuthoredAtMs)
      : input.parentAuthoredAtMs,
  ].filter(
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value),
  );
  return candidates.length === 0 ? undefined : Math.max(...candidates);
};

export type SyncDisclosureOptions = Readonly<{
  readonly actorUserId?: string;
}>;

/**
 * How far past this Device's clock a Revision's signer-chosen authored-at
 * instant may lie. Device and Membership windows are judged at that instant,
 * so an unbounded future (or a past earlier than the parent) would let a
 * signer move a Revision into whichever window authorizes it. The service
 * enforces the same bound at publication.
 */
export { MAX_REVISION_CLOCK_SKEW_MS } from "@dotrelay/contracts";

export type SyncPageVerificationOptions = SyncDisclosureOptions &
  Readonly<{
    /**
     * The starting point this Device requested the sync from. The page must
     * answer from exactly this point: a page that starts at a later Revision
     * would hide every Variable defined before it.
     */
    readonly expectedTrustedRevisionId: string;
    readonly expectedTrustedRevisionHash: Uint8Array;
    /**
     * The authored-at instant of the trusted starting Revision, when this
     * Device knows it; the first Revision of the page must not predate it.
     */
    readonly trustedRevisionAuthoredAtMs?: bigint;
    /**
     * The Project epoch of the trusted starting Revision, when this Device
     * knows it; no Revision of the page may name an older epoch.
     */
    readonly trustedRevisionProjectEpoch?: bigint;
    /**
     * The Server Profile, Team and Project this Device synced the page for.
     * Every Revision must name them (ADR 0023); a Revision of another
     * context never verifies here, whatever its signer.
     */
    readonly expectedContext?: SyncPageContext;
    /**
     * Revision ids this Device already verified in the Environment's history
     * before the page's starting point (an incremental sync). A Revision id
     * appears once in a history; a page that repeats one would let a signer
     * carry lanes sealed for that earlier Revision (ADR 0023). A sync from
     * genesis carries every id in the page itself and needs none.
     */
    readonly knownRevisionIds?: Iterable<string>;
    /** This Device's clock; defaults to Date.now(). */
    readonly nowMs?: number;
  }>;

export type SyncPageContext = Readonly<{
  readonly serverProfileId: string;
  readonly teamId: string;
  readonly projectId: string;
}>;

export type SyncDecodeOptions = Readonly<{
  /**
   * The Users whose legacy (format 1) lanes this Device applies: its own
   * User, which is always included, and the teammates whose identity it
   * confirmed (ADR 0023). A format-1 lane binds only its Variable, Revision
   * and scope, so any history signer could re-wrap a format-1 ciphertext
   * from another Environment of the same Project in a Revision of its own.
   * A format-1 lane whose Revision another User authored is therefore not
   * applied: its Variable reads as unreadable (UnreadableLaneError with the
   * reason "unconfirmed-legacy-author" at the head) until a later Revision
   * publishes it again in format 2 or the user confirms the author.
   */
  readonly legacyLaneAuthors?: Iterable<string>;
}>;

/**
 * The Project epoch keys this Device holds, keyed by Project epoch. Each lane
 * opens with the key of the epoch it names (lane field 30), so content sealed
 * before a Project epoch rotation stays readable after it. A single key is
 * accepted as a convenience and is tried for every lane.
 */
export type SharedValueKeyRing = ReadonlyMap<number, Uint8Array>;
export type SharedValueSecrets = Uint8Array | SharedValueKeyRing;

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
  /**
   * Every period in which the author was an active Member, oldest first. A
   * User removed and invited back has one period per stint; their earlier
   * Revisions verify against the period they were authored in. When present
   * it replaces the single memberSinceMs/memberUntilMs window.
   */
  readonly membershipPeriods?: readonly MembershipPeriod[];
}>;

export type MembershipPeriod = Readonly<{
  /** When the Membership became active (Unix milliseconds). */
  readonly sinceMs: number;
  /** When it was removed (Unix milliseconds); null while still active. */
  readonly untilMs: number | null;
}>;

export type RevisionSigningTrust =
  Uint8Array | readonly Uint8Array[] | readonly RevisionSigningTrustEntry[];

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
  "VARIABLE_DEFINITION" | "SHARED_VALUE" | "USER_DEFINED_VALUE";

/**
 * Why a lane is unreadable: this Device holds no key that opens it, or it is
 * a legacy (format 1) lane written by a User this Device has not confirmed
 * (ADR 0023), which it never applies.
 */
export type UnreadableLaneReason =
  "undecryptable" | "unconfirmed-legacy-author";

const laneKindLabel = (kind: UnreadableLaneKind): string =>
  kind === "VARIABLE_DEFINITION"
    ? "definition"
    : kind === "SHARED_VALUE"
      ? "Shared Value"
      : "User-defined Value";

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
  readonly reason: UnreadableLaneReason;
  /** For "unconfirmed-legacy-author": who authored the legacy lane. */
  readonly authorUserId: string | null;

  constructor(
    input: Readonly<{
      readonly variableId: string;
      readonly laneKind: UnreadableLaneKind;
      readonly ownerUserId?: string | null;
      readonly reason?: UnreadableLaneReason;
      readonly authorUserId?: string | null;
    }>,
  ) {
    super(
      input.reason === "unconfirmed-legacy-author"
        ? `Variable ${input.variableId}: its ${laneKindLabel(input.laneKind)} was written in the legacy lane format by a teammate this installation has not confirmed`
        : input.laneKind === "VARIABLE_DEFINITION"
          ? `Variable ${input.variableId}: its definition cannot be decrypted with this Device's Project key grant`
          : input.laneKind === "SHARED_VALUE"
            ? `Variable ${input.variableId}: its Shared Value cannot be decrypted with this Device's Project key grant`
            : `Variable ${input.variableId}: its User-defined Value cannot be decrypted with this Device's key grant`,
    );
    this.name = "UnreadableLaneError";
    this.variableId = input.variableId;
    this.laneKind = input.laneKind;
    this.ownerUserId = input.ownerUserId ?? null;
    this.reason = input.reason ?? "undecryptable";
    this.authorUserId = input.authorUserId ?? null;
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
    // Only a Value this publication writes must be present. An unchanged
    // Variable's lane is carried over from the head, not republished, and
    // may be absent here because it is another member's User-defined Value
    // that the service never sends to this user.
    if (variable.required && variable.value === null && variable.hasDraftChange)
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
  // The lane's identity is final before sealing, so its associated data
  // (lane format 2, ADR 0022) binds the ciphertext to this exact context.
  const identity = new Map<number, CborValue>([
    [8, uuidToBytes(context.serverProfileId)],
    [11, uuidToBytes(context.teamId)],
    [13, uuidToBytes(context.projectId)],
    [14, uuidToBytes(context.environmentId)],
    [15, uuidToBytes(variable.id)],
    [16, uuidToBytes(input.revisionId)],
    ...(input.ownerUserId
      ? [[26, uuidToBytes(input.ownerUserId)] as const]
      : []),
    ...(input.originalProviderUserId
      ? [[27, uuidToBytes(input.originalProviderUserId)] as const]
      : []),
    [30, context.projectEpoch],
    [36, input.scope],
    [50, LANE_FORMAT_CONTEXT_BOUND],
  ]);
  const associated = laneAssociatedData(identity);
  const envelopeBytes = input.sharedSecret
    ? await sealWithSharedSecret(
        input.plaintext,
        input.sharedSecret,
        associated,
      )
    : await seal(input.plaintext, input.recipientPublicKey, associated);
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
      ...identity,
      [17, uuidToBytes(uuid())],
      [18, uuidToBytes(laneId)],
      [46, iv],
      [47, ciphertext],
      [48, ciphertextHash],
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
  if (
    context.parentProjectEpoch !== undefined &&
    context.projectEpoch < context.parentProjectEpoch
  )
    throw new Error(
      "publication would seal Values under an older Project epoch than the verified head",
    );
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
    authoredAtMs: chooseRevisionAuthoredAtMs(
      context.nowMs ?? Date.now(),
      context.authoredAtNotBeforeMs,
    ),
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
// to read it and cannot, OTHER_UNREADABLE means a User-defined Value
// another User owns withheld it from this Device, and UNCONFIRMED_LEGACY
// means a legacy (format 1) lane by an author this Device has not
// confirmed, which it never applies (ADR 0023).
type LaneReadState =
  "READ" | "REQUIRED_UNREADABLE" | "OTHER_UNREADABLE" | "UNCONFIRMED_LEGACY";

type ValueLaneState = Readonly<{
  readonly state: LaneReadState;
  readonly scope: 3 | 4;
  readonly ownerUserId: string | null;
  /** For UNCONFIRMED_LEGACY: the author of the legacy lane. */
  readonly authorUserId?: string | null;
}>;

type DefinitionLaneState = Readonly<{
  readonly state: LaneReadState;
  readonly authorUserId?: string | null;
}>;

const isLegacyLane = (lane: ProtocolObject): boolean => {
  const format = lane.get(50);
  return format === LANE_FORMAT_LEGACY || format === BigInt(LANE_FORMAT_LEGACY);
};

// The author (field 22) of the Revision object a sync Revision carries.
const revisionAuthorUserId = (revision: SyncRevisionWire): string | null => {
  const revisionObject = revision.objects.find((object) =>
    bytesEqual(object.digest, revision.digest),
  );
  if (!revisionObject) return null;
  const author = parseProtocolObject(revisionObject.canonicalBytes).get(22);
  return author instanceof Uint8Array && author.length === 16
    ? bytesToUuid(author)
    : null;
};

export type SyncManifestDecode = Readonly<{
  /** The Manifest at the page's final Revision. */
  readonly variables: readonly DecodedVariable[];
  /**
   * The decoded Manifest at each Revision of the page, in page order; a
   * Value this Device cannot read is null, never an earlier Value.
   */
  readonly snapshots: ReadonlyMap<string, readonly DecodedVariable[]>;
}>;

// The Project epoch a lane was sealed under (field 30). A lane can never be
// sealed under an epoch later than its Revision's: that key did not exist yet.
const laneProjectEpoch = (
  lane: ProtocolObject,
  revisionEpoch: bigint,
): bigint => {
  const epoch = lane.get(30);
  const value =
    typeof epoch === "bigint"
      ? epoch
      : typeof epoch === "number" && Number.isSafeInteger(epoch)
        ? BigInt(epoch)
        : null;
  if (value === null || value < 1n)
    throw new ProtocolVerificationError("sync lane Project epoch is malformed");
  if (value > revisionEpoch)
    throw new ProtocolVerificationError(
      "sync lane Project epoch is later than its Revision's",
    );
  return value;
};

const sharedSecretForLane = (
  secrets: SharedValueSecrets | undefined,
  lane: ProtocolObject,
  revisionEpoch: bigint,
): Uint8Array | undefined => {
  const epoch = laneProjectEpoch(lane, revisionEpoch);
  if (secrets === undefined || secrets instanceof Uint8Array) return secrets;
  return epoch <= BigInt(Number.MAX_SAFE_INTEGER)
    ? secrets.get(Number(epoch))
    : undefined;
};

const decodedVariables = (
  variables: ReadonlyMap<string, DecodedVariableState>,
): readonly DecodedVariable[] =>
  Object.freeze(
    [...variables.entries()].map(([id, variable]) =>
      Object.freeze({ id, ...variable }),
    ),
  );

// The Manifest descriptor a Revision commits to through its Manifest hash
// (field 52). Any other kind-15 object in the Revision is ignored here and
// rejected by verifySyncPage.
const committedDescriptor = (
  revision: SyncRevisionWire,
): SyncRevisionWire["objects"][number] | undefined => {
  const revisionObject = revision.objects.find((object) =>
    bytesEqual(object.digest, revision.digest),
  );
  if (!revisionObject) return undefined;
  const manifestHash = parseProtocolObject(revisionObject.canonicalBytes).get(
    52,
  );
  if (!(manifestHash instanceof Uint8Array)) return undefined;
  return revision.objects.find(
    (object) =>
      bytesEqual(object.digest, manifestHash) &&
      parseProtocolObject(object.canonicalBytes).get(1) === 15,
  );
};

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
  sharedValueSecrets?: SharedValueSecrets,
  actorUserId?: string,
  userDefinedValueSecret?: Uint8Array,
  options: SyncDecodeOptions = {},
): Promise<SyncManifestDecode> => {
  // Legacy lanes apply only from this User and the teammates it confirmed.
  const legacyLaneAuthors = new Set<string>([
    ...(options.legacyLaneAuthors ?? []),
    ...(actorUserId === undefined ? [] : [actorUserId]),
  ]);
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
  const definitionStates = new Map<string, DefinitionLaneState>();
  const valueStates = new Map<string, ValueLaneState>();
  const snapshots = new Map<string, readonly DecodedVariable[]>();
  for (const revision of page.revisions) {
    const sharedValueSecret = (lane: ProtocolObject): Uint8Array | undefined =>
      sharedSecretForLane(sharedValueSecrets, lane, revision.projectEpoch);
    const authorUserId = revisionAuthorUserId(revision);
    // A legacy lane binds neither its Environment nor its author, so only
    // one this Device's own User or a confirmed teammate wrote is applied.
    const unconfirmedLegacy = (lane: ProtocolObject): boolean =>
      isLegacyLane(lane) &&
      (authorUserId === null || !legacyLaneAuthors.has(authorUserId));
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
        if (unconfirmedLegacy(lane)) {
          // Not applied: the Variable keeps no definition from this lane,
          // and fails the decode if no later Revision replaces it.
          definitionStates.set(id, {
            state: "UNCONFIRMED_LEGACY",
            authorUserId,
          });
          continue;
        }
        const plaintext = await openReadableLane(
          object.canonicalBytes,
          resolvePrivateKey("SHARED_VALUE"),
          sharedValueSecret(lane),
        );
        if (!plaintext) {
          // The head definition of this Variable is unverified; whether that
          // fails the decode is decided once the whole page is folded.
          definitionStates.set(id, { state: "REQUIRED_UNREADABLE" });
          continue;
        }
        definitionStates.set(id, { state: "READ" });
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
        // A deleted Variable has no Value, so an earlier Value this Device
        // could not read (or would not apply) no longer has to be read.
        if (definition.tombstone) valueStates.delete(id);
      } else if (scope === 3 || scope === 4) {
        const existing = variables.get(id);
        if (!existing) {
          // A Value lane needs its Variable's definition from this page or
          // from the Variables the caller already verified. When the
          // definition lane itself was unreadable the Value is unknown and
          // the unreadable definition fails the decode; otherwise the page
          // (or the caller's prior state) is incomplete, and skipping the
          // lane would silently drop the Variable.
          const definition = definitionStates.get(id);
          if (
            definition?.state === "REQUIRED_UNREADABLE" ||
            definition?.state === "UNCONFIRMED_LEGACY"
          ) {
            valueStates.set(id, {
              state: definition.state,
              scope,
              ownerUserId: scope === 4 ? laneUserId(lane, 26) : null,
              authorUserId: definition.authorUserId ?? null,
            });
            continue;
          }
          throw new ProtocolVerificationError(
            "sync Value lane has no known Variable definition",
          );
        }
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
        // Another User's User-defined Value is never opened with this
        // User's key, whatever ciphertext the lane carries: a lane the
        // service filled with this User's ciphertext would otherwise show
        // their Value as someone else's.
        if (
          scope === 4 &&
          actorUserId !== undefined &&
          existing.ownerUserId !== null &&
          existing.ownerUserId !== actorUserId
        ) {
          existing.value = null;
          valueStates.set(id, {
            state: "OTHER_UNREADABLE",
            scope: 4,
            ownerUserId: existing.ownerUserId,
          });
          continue;
        }
        if (unconfirmedLegacy(lane)) {
          // Never carry an earlier Value across a lane this Device does not
          // apply: until a later Revision replaces it the Value is unknown.
          existing.value = null;
          valueStates.set(id, {
            state: "UNCONFIRMED_LEGACY",
            scope,
            ownerUserId: scope === 4 ? existing.ownerUserId : null,
            authorUserId,
          });
          continue;
        }
        const plaintext = await openReadableLane(
          object.canonicalBytes,
          resolvePrivateKey(
            scope === 3 ? "SHARED_VALUE" : "USER_DEFINED_VALUE",
          ),
          scope === 3 ? sharedValueSecret(lane) : userDefinedValueSecret,
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
    const descriptorObject = committedDescriptor(revision);
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
    if (
      state.state === "REQUIRED_UNREADABLE" ||
      state.state === "UNCONFIRMED_LEGACY"
    )
      throw new UnreadableLaneError({
        variableId: id,
        laneKind: "VARIABLE_DEFINITION",
        ...(state.state === "UNCONFIRMED_LEGACY"
          ? {
              reason: "unconfirmed-legacy-author",
              authorUserId: state.authorUserId ?? null,
            }
          : {}),
      });
  for (const [id, state] of valueStates)
    if (
      state.state === "REQUIRED_UNREADABLE" ||
      state.state === "UNCONFIRMED_LEGACY"
    )
      throw new UnreadableLaneError({
        variableId: id,
        laneKind: state.scope === 3 ? "SHARED_VALUE" : "USER_DEFINED_VALUE",
        ownerUserId: state.ownerUserId,
        ...(state.state === "UNCONFIRMED_LEGACY"
          ? {
              reason: "unconfirmed-legacy-author",
              authorUserId: state.authorUserId ?? null,
            }
          : {}),
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
  sharedValueSecret?: SharedValueSecrets,
  actorUserId?: string,
  userDefinedValueSecret?: Uint8Array,
  options: SyncDecodeOptions = {},
): Promise<readonly DecodedVariable[]> =>
  (
    await decodeSyncManifest(
      page,
      resolvePrivateKey,
      existingVariables,
      sharedValueSecret,
      actorUserId,
      userDefinedValueSecret,
      options,
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
  readonly membershipPeriods?: readonly MembershipPeriod[];
}>;

const normalizeMembershipPeriods = (
  value: unknown,
): readonly MembershipPeriod[] => {
  if (!Array.isArray(value))
    throw new ProtocolVerificationError("signing trust entry is malformed");
  return value.map((period): MembershipPeriod => {
    if (
      typeof period !== "object" ||
      period === null ||
      typeof period.sinceMs !== "number" ||
      !Number.isSafeInteger(period.sinceMs) ||
      (period.untilMs !== null &&
        (typeof period.untilMs !== "number" ||
          !Number.isSafeInteger(period.untilMs)))
    )
      throw new ProtocolVerificationError("signing trust entry is malformed");
    return { sinceMs: period.sinceMs, untilMs: period.untilMs };
  });
};

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
      item.memberUntilMs !== undefined ||
      item.membershipPeriods !== undefined;
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
      ...(item.membershipPeriods !== undefined
        ? {
            membershipPeriods: normalizeMembershipPeriods(
              item.membershipPeriods,
            ),
          }
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
    !(entry.membershipPeriods === undefined
      ? windowAdmits(entry.memberSinceMs, entry.memberUntilMs, authoredAtMs)
      : entry.membershipPeriods.some((period) =>
          windowAdmits(period.sinceMs, period.untilMs, authoredAtMs),
        ))
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

type RevisionAuthorization = Readonly<{
  /** The keys whose entries authorized the Revision. */
  readonly keys: readonly Uint8Array[];
  /**
   * Whether an authorizing entry names the Revision's author, so the author
   * field is bound to the signing Device rather than claimed by the signer.
   */
  readonly authorBound: boolean;
}>;

const authorizeRevisionSignature = async (
  canonicalBytes: Uint8Array,
  entries: readonly SigningTrustEntry[],
  parsedRevision: ProtocolObject,
  authoredAtMs: bigint,
): Promise<RevisionAuthorization> => {
  const signingDeviceId = parsedRevision.get(23);
  const authorUserId = parsedRevision.get(22);
  const authorizing: Uint8Array[] = [];
  let authorBound = false;
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
      if (entry.userId !== undefined) authorBound = true;
    } catch (error) {
      lastError = error;
    }
  }
  if (authorizing.length > 0) return { keys: authorizing, authorBound };
  if (lastError instanceof ProtocolVerificationError) throw lastError;
  throw new ProtocolVerificationError(
    "sync revision signature is not authorized",
  );
};

// The fields that tie a lane or Manifest descriptor to the one Revision that
// carries it (ADR 0023): Server Profile, Team, Project, Environment and
// Revision id. Both lane formats bind field 16 into their associated data,
// so a lane copied from another Revision either fails these checks or fails
// to decrypt.
const REVISION_BINDING_FIELDS = [8, 11, 13, 14, 16] as const;

const boundToRevision = (
  object: ProtocolObject,
  revision: ProtocolObject,
): boolean =>
  REVISION_BINDING_FIELDS.every((field) => {
    const value = object.get(field);
    const expected = revision.get(field);
    return (
      value instanceof Uint8Array &&
      expected instanceof Uint8Array &&
      value.length === 16 &&
      bytesEqual(value, expected)
    );
  });

const laneFormatOf = (lane: ProtocolObject): number | null => {
  const format = lane.get(50);
  const value =
    typeof format === "bigint"
      ? Number(format)
      : typeof format === "number"
        ? format
        : null;
  return value !== null && LANE_FORMATS.includes(value) ? value : null;
};

export const verifySyncPage = async (
  page: SyncPageWire,
  signingTrust: RevisionSigningTrust,
  options: SyncPageVerificationOptions,
): Promise<void> => {
  // The page's own copy of the starting point is service-supplied: a page
  // that starts later than requested would chain-verify yet silently drop
  // every Variable defined before its first Revision.
  if (
    page.trustedRevisionId !== options.expectedTrustedRevisionId ||
    !bytesEqual(page.trustedRevisionHash, options.expectedTrustedRevisionHash)
  )
    throw new ProtocolVerificationError(
      "sync page does not start from the requested trusted revision",
    );
  const nowMs = Math.floor(options.nowMs ?? Date.now());
  let previousAuthoredAtMs = options.trustedRevisionAuthoredAtMs;
  // A Project epoch only moves forward along an Environment's history: a
  // Revision under an older epoch than its parent would undo a rotation.
  let previousProjectEpoch = options.trustedRevisionProjectEpoch;
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
  let expectedContext:
    Readonly<{ 8: Uint8Array; 11: Uint8Array; 13: Uint8Array }> | undefined;
  try {
    expectedContext = options.expectedContext
      ? {
          8: uuidToBytes(options.expectedContext.serverProfileId),
          11: uuidToBytes(options.expectedContext.teamId),
          13: uuidToBytes(options.expectedContext.projectId),
        }
      : undefined;
  } catch {
    throw new ProtocolVerificationError("sync page context is malformed");
  }
  // Every Revision id the Environment's verified history already holds: the
  // starting point, the Environment's own id (the genesis anchor), and what
  // the caller verified before. A Revision may not reuse any of them, nor an
  // id earlier in this page (ADR 0023).
  const historyRevisionIds = new Set<string>(
    [
      page.environmentId,
      page.trustedRevisionId,
      ...(options.knownRevisionIds ?? []),
    ].map((id) => id.toLowerCase()),
  );
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
    if (historyRevisionIds.has(revision.id.toLowerCase()))
      throw new ProtocolVerificationError(
        "sync page repeats a Revision id the Environment's history already holds",
      );
    historyRevisionIds.add(revision.id.toLowerCase());
    if (
      expectedContext &&
      !([8, 11, 13] as const).every((field) => {
        const value = parsedRevision.get(field);
        return (
          value instanceof Uint8Array &&
          bytesEqual(value, expectedContext[field])
        );
      })
    )
      throw new ProtocolVerificationError(
        "sync revision belongs to another Server Profile, Team or Project",
      );
    const actualRevisionDigest = await sha384(revisionObject.canonicalBytes);
    if (!bytesEqual(actualRevisionDigest, revision.digest))
      throw new ProtocolVerificationError("revision digest mismatch");
    // Authorization windows are judged at the signer-chosen authored-at
    // instant, so bound it: never before the parent, never in the future
    // beyond clock skew.
    if (
      checkRevisionAuthoredAt({
        authoredAtMs: revision.authoredAtMs,
        notBeforeMs: previousAuthoredAtMs ?? null,
        nowMs,
      }) !== "ok"
    )
      throw new ProtocolVerificationError(
        "sync revision authored-at instant is outside its allowed range",
      );
    previousAuthoredAtMs = revision.authoredAtMs;
    if (
      previousProjectEpoch !== undefined &&
      revision.projectEpoch < previousProjectEpoch
    )
      throw new ProtocolVerificationError(
        "sync revision Project epoch is older than its parent's",
      );
    previousProjectEpoch = revision.projectEpoch;
    let revisionTrustKeys: readonly Uint8Array[] = trustKeys;
    // Plain keys verify a signature but say nothing about who authored it.
    let authorBound = false;
    if (scopedTrust) {
      const authorization = await authorizeRevisionSignature(
        revisionObject.canonicalBytes,
        trustEntries,
        parsedRevision,
        revision.authoredAtMs,
      );
      revisionTrustKeys = authorization.keys;
      authorBound = authorization.authorBound;
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
    // Value lanes speak for the Revision's author only: a User-defined Value
    // lane names them as owner, a Shared Value lane as provider.
    const authorUserId = parsedRevision.get(22);
    const attributedToAuthor = (
      fields: ReadonlyMap<number, CborValue>,
      scope: unknown,
    ): boolean => {
      const owner = fields.get(26);
      const provider = fields.get(27);
      const isAuthor = (value: CborValue | undefined): boolean =>
        value instanceof Uint8Array &&
        authorUserId instanceof Uint8Array &&
        bytesEqual(value, authorUserId);
      if (scope === 4) return isAuthor(owner) && provider === undefined;
      if (scope === 3) return isAuthor(provider) && owner === undefined;
      return owner === undefined && provider === undefined;
    };
    for (const commitment of commitments)
      if (!attributedToAuthor(commitment, commitment.get(36)))
        throw new ProtocolVerificationError(
          "sync lane commitment is not attributed to the revision author",
        );
    const disclosedLaneIds = new Set<string>();
    for (const object of revision.objects) {
      const digest = await sha384(object.canonicalBytes);
      if (!bytesEqual(digest, object.digest))
        throw new ProtocolVerificationError("sync object digest mismatch");
      const parsed = parseProtocolObject(object.canonicalBytes);
      // A Revision carries exactly its own signed Revision object, the one
      // descriptor its Manifest hash names, and committed lanes. Anything
      // else is service-supplied and would otherwise reach the decoder.
      const objectKind = parsed.get(1);
      if (
        !(objectKind === 16 && object === revisionObject) &&
        !(objectKind === 15 && object === descriptorObject) &&
        objectKind !== 13
      )
        throw new ProtocolVerificationError(
          "sync revision carries an object its Manifest does not commit to",
        );
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
      // A lane or descriptor speaks only for the Revision that carries it:
      // one copied from an earlier Revision, or from another Environment,
      // Project, Team or Server Profile, is refused (ADR 0023).
      if (
        (objectKind === 13 || objectKind === 15) &&
        !boundToRevision(parsed, parsedRevision)
      )
        throw new ProtocolVerificationError(
          "sync object is not bound to the Revision that carries it",
        );
      if (parsed.get(1) === 13) {
        laneProjectEpoch(parsed, revision.projectEpoch);
        const laneId = parsed.get(18);
        const laneScope = parsed.get(36);
        const laneCiphertextLength = parsed.get(72);
        const laneFormat = laneFormatOf(parsed);
        if (laneFormat === null)
          throw new ProtocolVerificationError(
            "sync lane names an unknown lane format",
          );
        // A legacy User-defined Value lane binds neither its context nor its
        // owner into its ciphertext. Only a signer bound to the Revision's
        // author (and so to the owner) may carry one; a plain key could claim
        // any author and present another context's ciphertext as theirs.
        if (
          laneFormat === LANE_FORMAT_LEGACY &&
          laneScope === 4 &&
          !authorBound
        )
          throw new ProtocolVerificationError(
            "a legacy User-defined Value lane needs a signer bound to its author",
          );
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
        if (disclosedLaneIds.has(bytesToUuid(laneId)))
          throw new ProtocolVerificationError("sync lane is disclosed twice");
        if (!attributedToAuthor(parsed, laneScope))
          throw new ProtocolVerificationError(
            "sync lane is not attributed to the revision author",
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
  // Field 50 names how much of the lane's context the ciphertext is bound
  // to (ADR 0022); the lane's signature covers it.
  const associated = laneAssociatedData(lane);
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
  const encoded = canonicalEncode(envelope);
  try {
    return await open(encoded, recipientPrivateKey, associated);
  } catch (error) {
    if (!sharedValueSecret || !(error instanceof InvalidCiphertextError))
      throw error;
    return openWithSharedSecret(encoded, sharedValueSecret, associated);
  }
};
