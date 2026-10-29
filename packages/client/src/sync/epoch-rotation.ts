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

export type EpochRotationEnvironment = Readonly<{
  readonly environmentId: string;
  readonly expectedHeadId: string;
  readonly expectedHeadHash: Uint8Array;
}>;

export type EpochRotationInput = Readonly<{
  readonly serverProfileId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly expectedEpoch: number;
  readonly environments: readonly EpochRotationEnvironment[];
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

type RotationSharedContext = Readonly<{
  readonly serverProfileId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly expectedEpoch: number;
  readonly newEpoch: number;
  readonly authoredAtMs: number;
  readonly signingPrivateKey: CryptoKey;
}>;

type EnvironmentTransition = Readonly<{
  readonly environmentId: string;
  readonly expectedHeadId: string;
  readonly newHeadId: string;
  readonly protocolObjectId: string;
  readonly commandBytes: Uint8Array;
  readonly stagedObjects: ReadonlyArray<
    Readonly<{ readonly objectId: string; readonly bytes: Uint8Array }>
  >;
  readonly publication: FinalizePublicationRequest;
}>;

const buildEnvironmentTransition = async (
  shared: RotationSharedContext,
  environment: EpochRotationEnvironment,
): Promise<EnvironmentTransition> => {
  const revisionId = uuid();
  const descriptor = await signedObject(
    15,
    new Map<number, CborValue>([
      [8, uuidToBytes(shared.serverProfileId)],
      [11, uuidToBytes(shared.teamId)],
      [13, uuidToBytes(shared.projectId)],
      [14, uuidToBytes(environment.environmentId)],
      [16, uuidToBytes(revisionId)],
      [30, shared.newEpoch],
      [50, 1],
      [53, []],
    ]),
    shared.signingPrivateKey,
  );
  const descriptorHash = await sha384(descriptor.bytes);
  const revision = await signedObject(
    16,
    new Map<number, CborValue>([
      [8, uuidToBytes(shared.serverProfileId)],
      [11, uuidToBytes(shared.teamId)],
      [13, uuidToBytes(shared.projectId)],
      [14, uuidToBytes(environment.environmentId)],
      [16, uuidToBytes(revisionId)],
      [17, uuidToBytes(uuid())],
      [19, uuidToBytes(environment.expectedHeadId)],
      [20, environment.expectedHeadHash],
      [22, uuidToBytes(shared.actorUserId)],
      [23, uuidToBytes(shared.actorDeviceId)],
      [30, shared.newEpoch],
      [34, shared.authoredAtMs],
      [35, 4],
      [50, 1],
      [51, descriptor.bytes],
      [52, descriptorHash],
      [53, []],
      [54, []],
    ]),
    shared.signingPrivateKey,
  );
  const revisionHash = await sha384(revision.bytes);
  const transition = await signedObject(
    12,
    new Map<number, CborValue>([
      [8, uuidToBytes(shared.serverProfileId)],
      [11, uuidToBytes(shared.teamId)],
      [13, uuidToBytes(shared.projectId)],
      [17, uuidToBytes(uuid())],
      [23, uuidToBytes(shared.actorDeviceId)],
      [32, shared.authoredAtMs],
      [55, []],
      [56, []],
      [62, shared.expectedEpoch],
      [63, shared.newEpoch],
      [64, uuidToBytes(environment.expectedHeadId)],
      [65, environment.expectedHeadHash],
      [66, uuidToBytes(revisionId)],
      [67, revisionHash],
    ]),
    shared.signingPrivateKey,
  );
  const publication: FinalizePublicationRequest = {
    environmentId: environment.environmentId,
    expectedHeadId: environment.expectedHeadId,
    revision: {
      id: revisionId,
      protocolObjectId: revision.id,
      parentHash: environment.expectedHeadHash,
      projectEpoch: shared.newEpoch,
      mutation: "EPOCH_TRANSITION",
      authoredAtMs: shared.authoredAtMs,
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
    environmentId: environment.environmentId,
    expectedHeadId: environment.expectedHeadId,
    newHeadId: revisionId,
    protocolObjectId: transition.id,
    commandBytes: transition.bytes,
    stagedObjects: Object.freeze([
      Object.freeze({ objectId: descriptor.id, bytes: descriptor.bytes }),
      Object.freeze({ objectId: revision.id, bytes: revision.bytes }),
      Object.freeze({ objectId: transition.id, bytes: transition.bytes }),
    ]),
    publication,
  });
};

export const createEpochRotationArtifacts = async (
  input: EpochRotationInput,
): Promise<EpochRotationArtifacts> => {
  if (
    !Number.isSafeInteger(input.expectedEpoch) ||
    input.expectedEpoch < 1 ||
    input.environments.length < 1 ||
    input.environments.some(
      (environment) =>
        environment.environmentId.length === 0 ||
        environment.expectedHeadId.length === 0 ||
        environment.expectedHeadHash.length !== 48,
    )
  )
    throw new TypeError("project epoch rotation context is invalid");
  const newEpoch = input.expectedEpoch + 1;
  const authoredAtMs = input.authoredAtMs ?? Date.now();
  const shared: RotationSharedContext = Object.freeze({
    serverProfileId: input.serverProfileId,
    teamId: input.teamId,
    projectId: input.projectId,
    actorUserId: input.actorUserId,
    actorDeviceId: input.actorDeviceId,
    expectedEpoch: input.expectedEpoch,
    newEpoch,
    authoredAtMs,
    signingPrivateKey: input.signingPrivateKey,
  });
  // The backend applies a rotation against every active environment in one
  // operation and validates transitions in environmentId order, so build them
  // sorted. The single command object is the first environment's transition;
  // the backend drives the rotation from the per-environment transitions.
  const transitions = await Promise.all(
    [...input.environments]
      .sort((left, right) =>
        left.environmentId.localeCompare(right.environmentId),
      )
      .map((environment) => buildEnvironmentTransition(shared, environment)),
  );
  const stagedObjects = transitions.flatMap((transition) => [
    ...transition.stagedObjects,
  ]);
  const [firstTransition] = transitions;
  return Object.freeze({
    commandBytes: firstTransition!.commandBytes,
    stagedObjects: Object.freeze(stagedObjects),
    request: Object.freeze({
      projectId: input.projectId,
      expectedEpoch: input.expectedEpoch,
      newEpoch,
      transitions: Object.freeze(
        transitions.map((transition) =>
          Object.freeze({
            environmentId: transition.environmentId,
            expectedHeadId: transition.expectedHeadId,
            newHeadId: transition.newHeadId,
            protocolObjectId: transition.protocolObjectId,
            publication: transition.publication,
          }),
        ),
      ),
    }),
  });
};
