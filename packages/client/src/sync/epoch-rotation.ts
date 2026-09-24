import {
  type CborValue,
  canonicalEncode,
  encodeProtocolObject,
  type FinalizePublicationRequest,
  protocolObjectFromFields,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";

export type EpochRotationInput = Readonly<{
  readonly serverProfileId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly expectedEpoch: number;
  readonly expectedHeadId: string;
  readonly expectedHeadHash: Uint8Array;
  readonly signingPrivateKey: CryptoKey;
  readonly authoredAtMs?: number;
}>;

export type EpochRotationArtifacts = Readonly<{
  readonly commandBytes: Uint8Array;
  readonly stagedObjects: ReadonlyArray<
    Readonly<{ readonly objectId: string; readonly bytes: Uint8Array }>
  >;
  readonly request: Readonly<{
    readonly projectId: string;
    readonly expectedEpoch: number;
    readonly newEpoch: number;
    readonly transitions: ReadonlyArray<
      Readonly<{
        readonly environmentId: string;
        readonly expectedHeadId: string;
        readonly newHeadId: string;
        readonly protocolObjectId: string;
        readonly publication: FinalizePublicationRequest;
      }>
    >;
  }>;
}>;

const uuid = (): string => crypto.randomUUID();

const signedObject = async (
  kind: number,
  fields: ReadonlyMap<number, CborValue>,
  signingPrivateKey: CryptoKey,
): Promise<
  Readonly<{
    readonly id: string;
    readonly bytes: Uint8Array;
  }>
> => {
  const unsigned = protocolObjectFromFields(kind, fields);
  const envelope = new Map<number, CborValue>([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  const placeholder = protocolObjectFromFields(kind, envelope);
  const signature = await signProtocolObject(placeholder, signingPrivateKey);
  envelope.set(4, signature);
  return Object.freeze({
    id: uuid(),
    bytes: encodeProtocolObject(protocolObjectFromFields(kind, envelope)),
  });
};

export const createEpochRotationArtifacts = async (
  input: EpochRotationInput,
): Promise<EpochRotationArtifacts> => {
  if (
    !Number.isSafeInteger(input.expectedEpoch) ||
    input.expectedEpoch < 1 ||
    input.expectedHeadHash.length !== 48
  )
    throw new TypeError("project epoch rotation context is invalid");
  const newEpoch = input.expectedEpoch + 1;
  const authoredAtMs = input.authoredAtMs ?? Date.now();
  const revisionId = uuid();
  const descriptor = await signedObject(
    15,
    new Map<number, CborValue>([
      [8, uuidToBytes(input.serverProfileId)],
      [11, uuidToBytes(input.teamId)],
      [13, uuidToBytes(input.projectId)],
      [14, uuidToBytes(input.environmentId)],
      [16, uuidToBytes(revisionId)],
      [30, newEpoch],
      [50, 1],
      [53, []],
    ]),
    input.signingPrivateKey,
  );
  const descriptorHash = await sha384(descriptor.bytes);
  const revision = await signedObject(
    16,
    new Map<number, CborValue>([
      [8, uuidToBytes(input.serverProfileId)],
      [11, uuidToBytes(input.teamId)],
      [13, uuidToBytes(input.projectId)],
      [14, uuidToBytes(input.environmentId)],
      [16, uuidToBytes(revisionId)],
      [17, uuidToBytes(uuid())],
      [19, uuidToBytes(input.expectedHeadId)],
      [20, input.expectedHeadHash],
      [22, uuidToBytes(input.actorUserId)],
      [23, uuidToBytes(input.actorDeviceId)],
      [30, newEpoch],
      [34, authoredAtMs],
      [35, 4],
      [50, 1],
      [51, descriptor.bytes],
      [52, descriptorHash],
      [53, []],
      [54, []],
    ]),
    input.signingPrivateKey,
  );
  const revisionHash = await sha384(revision.bytes);
  const transition = await signedObject(
    12,
    new Map<number, CborValue>([
      [8, uuidToBytes(input.serverProfileId)],
      [11, uuidToBytes(input.teamId)],
      [13, uuidToBytes(input.projectId)],
      [17, uuidToBytes(uuid())],
      [23, uuidToBytes(input.actorDeviceId)],
      [32, authoredAtMs],
      [55, []],
      [56, []],
      [62, input.expectedEpoch],
      [63, newEpoch],
      [64, uuidToBytes(input.expectedHeadId)],
      [65, input.expectedHeadHash],
      [66, uuidToBytes(revisionId)],
      [67, revisionHash],
    ]),
    input.signingPrivateKey,
  );
  const publication: FinalizePublicationRequest = {
    environmentId: input.environmentId,
    expectedHeadId: input.expectedHeadId,
    revision: {
      id: revisionId,
      protocolObjectId: revision.id,
      parentHash: input.expectedHeadHash,
      projectEpoch: newEpoch,
      mutation: "EPOCH_TRANSITION",
      authoredAtMs,
    },
    descriptor: {
      protocolObjectId: descriptor.id,
      schemaVersion: 1,
      descriptorHash,
      laneCount: 0,
    },
    lanes: [],
    commitments: [],
  };
  return Object.freeze({
    commandBytes: transition.bytes,
    stagedObjects: Object.freeze([
      Object.freeze({ objectId: descriptor.id, bytes: descriptor.bytes }),
      Object.freeze({ objectId: revision.id, bytes: revision.bytes }),
      Object.freeze({ objectId: transition.id, bytes: transition.bytes }),
    ]),
    request: Object.freeze({
      projectId: input.projectId,
      expectedEpoch: input.expectedEpoch,
      newEpoch,
      transitions: Object.freeze([
        Object.freeze({
          environmentId: input.environmentId,
          expectedHeadId: input.expectedHeadId,
          newHeadId: revisionId,
          protocolObjectId: transition.id,
          publication,
        }),
      ]),
    }),
  });
};
