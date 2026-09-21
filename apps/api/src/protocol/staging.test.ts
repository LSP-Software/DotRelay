import { describe, expect, test } from "bun:test";
import {
  type CborValue,
  ContractError,
  canonicalEncode,
  generateSigningKeyPair,
  parseProtocolObject,
  protocolObjectFromFields,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import type { RevisionPublicationInput } from "@dotrelay/database";
import { COMMAND_STAGE_OBJECT_ID } from "./constants";
import { buildPublicationInput } from "./staging";

// The actor is the revision publisher (the would-be attacker). The victim is
// another User of the same Team whose identity the actor's lane objects
// claim as owner (User-defined Value) or original provider (Shared Value).
const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const TEAM_ID = "10000000-0000-4000-8000-000000000002";
const PROJECT_ID = "10000000-0000-4000-8000-000000000003";
const ENVIRONMENT_ID = "10000000-0000-4000-8000-000000000004";
const ACTOR_USER_ID = "10000000-0000-4000-8000-000000000005";
const VICTIM_USER_ID = "10000000-0000-4000-8000-000000000006";
const ACTOR_DEVICE_ID = "10000000-0000-4000-8000-000000000007";
const VARIABLE_ID = "10000000-0000-4000-8000-000000000008";
const LANE_OBJECT_ID = "10000000-0000-4000-8000-000000000009";
const REVISION_ID = "10000000-0000-4000-8000-00000000000a";
const REVISION_OBJECT_ID = "10000000-0000-4000-8000-00000000000b";
const DESCRIPTOR_OBJECT_ID = "10000000-0000-4000-8000-00000000000c";
const OPERATION_ID = "10000000-0000-4000-8000-00000000000d";
const AUTHORED_AT_MS = 1_750_000_000_000;
const PROJECT_EPOCH = 1;
const PLAINTEXT_LENGTH = 16;
const CIPHERTEXT_LENGTH = 32; // AES-GCM tag: ciphertext = plaintext + 16

type StagedRow = Readonly<{
  readonly objectId: string;
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
}>;

type SignedObject = Readonly<{
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
}>;

type FinalizeScenario = Readonly<{
  readonly laneBytes: Uint8Array;
  readonly buildInput: () => RevisionPublicationInput;
}>;

const zeroBytes = (length: number): Uint8Array => new Uint8Array(length);

// Re-derives the signed envelope exactly as a client does: field 3 is the
// canonical body digest of every non-signed field and field 4 is a real
// Ed25519 signature over that body. Flipping an identity field (owner or
// original provider) and re-signing yields a structurally valid, internally
const signObject = async (
  kind: number,
  fields: ReadonlyMap<number, CborValue>,
  signingKey: CryptoKey,
): Promise<SignedObject> => {
  // The envelope is the full object with a placeholder signature; its
  // unsigned body (every field except 3 and 4) is the canonical digest that
  // field 3 must carry, mirroring the client's signing flow.
  const envelope = new Map<number, CborValue>(fields);
  envelope.set(4, zeroBytes(64));
  const candidate = protocolObjectFromFields(kind, envelope);
  const unsignedBytes = canonicalEncode(
    new Map(
      [...candidate.entries()].filter(([field]) => field !== 3 && field !== 4),
    ),
  );
  envelope.set(3, unsignedBytes);
  const signature = await signProtocolObject(
    protocolObjectFromFields(kind, envelope),
    signingKey,
  );
  envelope.set(4, signature);
  const bytes = canonicalEncode(protocolObjectFromFields(kind, envelope));
  return {
    bytes,
    digest: await sha384(bytes),
  };
};

const createFinalizeScenario = async (input: {
  readonly scope: 3 | 4; // 3 = SHARED_VALUE, 4 = USER_DEFINED_VALUE
  readonly owner: string | null;
  readonly provider: string | null;
}): Promise<FinalizeScenario> => {
  const signing = await generateSigningKeyPair();
  const laneFields = new Map<number, CborValue>([
    [8, uuidToBytes(PROFILE_ID)],
    [11, uuidToBytes(TEAM_ID)],
    [13, uuidToBytes(PROJECT_ID)],
    [14, uuidToBytes(ENVIRONMENT_ID)],
    [15, uuidToBytes(VARIABLE_ID)],
    [16, uuidToBytes(REVISION_ID)],
    [17, uuidToBytes(REVISION_ID)],
    [18, uuidToBytes(LANE_OBJECT_ID)],
    [30, PROJECT_EPOCH],
    [36, input.scope],
    [46, zeroBytes(12)],
    [47, zeroBytes(CIPHERTEXT_LENGTH)],
    [48, zeroBytes(48)],
    [50, 1],
    [
      69,
      new Map<number, CborValue>([
        [44, zeroBytes(32)],
        [45, zeroBytes(32)],
      ]),
    ],
    [71, PLAINTEXT_LENGTH],
    [72, CIPHERTEXT_LENGTH],
  ]);
  if (input.owner) laneFields.set(26, uuidToBytes(input.owner));
  if (input.provider) laneFields.set(27, uuidToBytes(input.provider));
  const lane = await signObject(13, laneFields, signing.privateKey);

  const commitment = new Map<number, CborValue>([
    [18, uuidToBytes(LANE_OBJECT_ID)],
    [36, input.scope],
    [48, lane.digest],
    [72, CIPHERTEXT_LENGTH],
  ]);
  if (input.owner) commitment.set(26, uuidToBytes(input.owner));
  if (input.provider) commitment.set(27, uuidToBytes(input.provider));

  const descriptorFields = new Map<number, CborValue>([
    [8, uuidToBytes(PROFILE_ID)],
    [11, uuidToBytes(TEAM_ID)],
    [13, uuidToBytes(PROJECT_ID)],
    [14, uuidToBytes(ENVIRONMENT_ID)],
    [16, uuidToBytes(REVISION_ID)],
    [30, PROJECT_EPOCH],
    [50, 1],
    [53, [commitment]],
  ]);
  const descriptor = await signObject(15, descriptorFields, signing.privateKey);

  const revisionFields = new Map<number, CborValue>([
    [8, uuidToBytes(PROFILE_ID)],
    [11, uuidToBytes(TEAM_ID)],
    [13, uuidToBytes(PROJECT_ID)],
    [14, uuidToBytes(ENVIRONMENT_ID)],
    [16, uuidToBytes(REVISION_ID)],
    [17, uuidToBytes(REVISION_ID)],
    [19, uuidToBytes(ENVIRONMENT_ID)],
    [20, zeroBytes(48)],
    [22, uuidToBytes(ACTOR_USER_ID)],
    [23, uuidToBytes(ACTOR_DEVICE_ID)],
    [30, PROJECT_EPOCH],
    [34, AUTHORED_AT_MS],
    [35, 1], // GENESIS
    [50, 1],
    [51, descriptor.bytes],
    [52, descriptor.digest],
    [53, [commitment]],
    [54, [uuidToBytes(VARIABLE_ID)]],
  ]);
  const revision = await signObject(16, revisionFields, signing.privateKey);

  const stagedById = new Map<string, StagedRow>([
    [
      COMMAND_STAGE_OBJECT_ID,
      {
        objectId: COMMAND_STAGE_OBJECT_ID,
        canonicalBytes: revision.bytes,
        digest: revision.digest,
      },
    ],
    [
      REVISION_OBJECT_ID,
      {
        objectId: REVISION_OBJECT_ID,
        canonicalBytes: revision.bytes,
        digest: revision.digest,
      },
    ],
    [
      DESCRIPTOR_OBJECT_ID,
      {
        objectId: DESCRIPTOR_OBJECT_ID,
        canonicalBytes: descriptor.bytes,
        digest: descriptor.digest,
      },
    ],
    [
      LANE_OBJECT_ID,
      {
        objectId: LANE_OBJECT_ID,
        canonicalBytes: lane.bytes,
        digest: lane.digest,
      },
    ],
  ]);
  const scope = input.scope === 4 ? "USER_DEFINED_VALUE" : "SHARED_VALUE";
  const commandStaged = stagedById.get(COMMAND_STAGE_OBJECT_ID) as StagedRow;
  const buildInput = () =>
    buildPublicationInput({
      operationId: OPERATION_ID,
      actorUserId: ACTOR_USER_ID,
      actorDeviceId: ACTOR_DEVICE_ID,
      commandStaged,
      operationExpiresAt: null,
      finalizeRequest: {
        environmentId: ENVIRONMENT_ID,
        expectedHeadId: null,
        revision: {
          id: REVISION_ID,
          protocolObjectId: REVISION_OBJECT_ID,
          projectEpoch: PROJECT_EPOCH,
          mutation: "GENESIS",
          authoredAtMs: AUTHORED_AT_MS,
        },
        descriptor: {
          protocolObjectId: DESCRIPTOR_OBJECT_ID,
          schemaVersion: 1,
          descriptorHash: descriptor.digest,
          laneCount: 1,
        },
        lanes: [
          {
            id: LANE_OBJECT_ID,
            protocolObjectId: LANE_OBJECT_ID,
            scope,
            ...(input.owner ? { ownerUserId: input.owner } : {}),
            ...(input.provider
              ? { originalProviderUserId: input.provider }
              : {}),
            projectEpoch: PROJECT_EPOCH,
            plaintextLength: PLAINTEXT_LENGTH,
            ciphertextLength: CIPHERTEXT_LENGTH,
            ciphertextHash: zeroBytes(48),
          },
        ],
        commitments: [
          {
            ordinal: 0,
            laneObjectId: LANE_OBJECT_ID,
            objectHash: lane.digest,
            projectEpoch: PROJECT_EPOCH,
            scope,
            ...(input.owner ? { ownerUserId: input.owner } : {}),
            ...(input.provider
              ? { originalProviderUserId: input.provider }
              : {}),
            ciphertextLength: CIPHERTEXT_LENGTH,
          },
        ],
      },
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      stagedById,
    });
  return { laneBytes: lane.bytes, buildInput };
};

type BuildResult =
  | { readonly ok: true; readonly input: RevisionPublicationInput }
  | { readonly ok: false; readonly error: unknown };

const runBuild = (buildInput: () => RevisionPublicationInput): BuildResult => {
  try {
    return { ok: true, input: buildInput() };
  } catch (error) {
    return { ok: false, error };
  }
};

const requireBuildInput = (result: BuildResult): RevisionPublicationInput => {
  if (!result.ok)
    throw new Error(
      `publication rejected unexpectedly: ${String(result.error)}`,
    );
  return result.input;
};

const requireBuildError = (result: BuildResult): unknown => {
  if (result.ok) throw new Error("publication was accepted unexpectedly");
  return result.error;
};

describe("publication lane ownership validation", () => {
  test("accepts a User-defined Value lane the publisher owns", async () => {
    const scenario = await createFinalizeScenario({
      scope: 4,
      owner: ACTOR_USER_ID,
      provider: null,
    });
    const input = requireBuildInput(runBuild(scenario.buildInput));
    expect(input.operation.actorUserId).toBe(ACTOR_USER_ID);
    expect(input.lanes).toHaveLength(1);
    const [lane] = input.lanes;
    expect(lane?.lane.scope).toBe("USER_DEFINED_VALUE");
    expect(lane?.lane.ownerUserId).toBe(ACTOR_USER_ID);
  });

  test("rejects a User-defined Value lane whose signed owner is another User", async () => {
    const scenario = await createFinalizeScenario({
      scope: 4,
      owner: VICTIM_USER_ID,
      provider: null,
    });
    // The actor's lane names the victim and is still structurally valid:
    // the body digest and the Ed25519 signature both cover the tampered
    // owner, so parsing and projection validation pass. Only the ownership
    // check binds the signed owner to the actor.
    parseProtocolObject(scenario.laneBytes);
    const error = requireBuildError(runBuild(scenario.buildInput));
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe("invalid_crypto_object");
  });

  test("accepts a Shared Value lane the publisher provided", async () => {
    const scenario = await createFinalizeScenario({
      scope: 3,
      owner: null,
      provider: ACTOR_USER_ID,
    });
    const input = requireBuildInput(runBuild(scenario.buildInput));
    const [lane] = input.lanes;
    expect(lane?.lane.scope).toBe("SHARED_VALUE");
    expect(lane?.lane.originalProviderUserId).toBe(ACTOR_USER_ID);
    expect(lane?.lane.ownerUserId).toBeUndefined();
  });

  test("rejects a Shared Value lane whose signed provider is another User", async () => {
    const scenario = await createFinalizeScenario({
      scope: 3,
      owner: null,
      provider: VICTIM_USER_ID,
    });
    const error = requireBuildError(runBuild(scenario.buildInput));
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe("invalid_crypto_object");
  });
});
