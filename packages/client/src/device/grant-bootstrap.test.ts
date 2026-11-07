import { describe, expect, test } from "bun:test";
import {
  type CborValue,
  canonicalEncode,
  decodeCiphertextEnvelope,
  encodeProtocolObject,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  open,
  parseProtocolObject,
  protocolObjectFromFields,
  seal,
  signProtocolObject,
  uuidToBytes,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import {
  createProjectEpochGrantBootstrap,
  exportSigningPublicKey,
  openProjectEpochGrant,
  type ProjectEpochGrantExpectation,
  ProjectEpochGrantVerificationError,
} from "../index";

const SERVER_PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const SENDER_DEVICE_ID = "44444444-4444-4444-8444-444444444444";
const PEER_DEVICE_ID = "55555555-5555-4555-8555-555555555555";

const expectedFor = (
  recipientDeviceId: string,
  overrides: Partial<ProjectEpochGrantExpectation> = {},
): ProjectEpochGrantExpectation => ({
  recipientDeviceId,
  projectId: PROJECT_ID,
  projectEpoch: 1,
  serverProfileId: SERVER_PROFILE_ID,
  teamId: TEAM_ID,
  ...overrides,
});

const fixture = async () => {
  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const trustedSigningKeys = [await exportSigningPublicKey(signing.publicKey)];
  const grant = await createProjectEpochGrantBootstrap({
    serverProfileId: SERVER_PROFILE_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    projectEpoch: 1,
    senderDeviceId: SENDER_DEVICE_ID,
    recipientDeviceId: SENDER_DEVICE_ID,
    recipientX25519PublicKey: new Uint8Array(32),
    recipientEncryptionPublicKey: encryption.publicKey,
    signingPrivateKey: signing.privateKey,
  });
  return { encryption, signing, trustedSigningKeys, grant };
};

// A grant the server built itself: a key of its choosing sealed to the
// recipient's public X25519 key, with an optional signature.
const forgeGrant = async (
  recipientEncryptionPublicKey: CryptoKey,
  plaintextKey: Uint8Array,
  signingPrivateKey?: CryptoKey,
): Promise<Uint8Array> => {
  const envelope = decodeCiphertextEnvelope(
    await seal(plaintextKey, recipientEncryptionPublicKey),
  );
  const grantFields = new Map<number, CborValue>([
    [8, uuidToBytes(SERVER_PROFILE_ID)],
    [11, uuidToBytes(TEAM_ID)],
    [13, uuidToBytes(PROJECT_ID)],
    [17, uuidToBytes(crypto.randomUUID())],
    [24, uuidToBytes(SENDER_DEVICE_ID)],
    [25, uuidToBytes(SENDER_DEVICE_ID)],
    [30, 1],
    [37, 1],
    [39, new Uint8Array(32)],
    ...[44, 45, 46, 47, 48, 71, 72].map((field): [number, CborValue] => [
      field,
      envelope.get(field) as CborValue,
    ]),
    [70, 1],
  ]);
  const fields = new Map<number, CborValue>([
    ...grantFields,
    [3, canonicalEncode(protocolObjectFromFields(7, grantFields))],
    [4, new Uint8Array(64)],
  ]);
  if (signingPrivateKey)
    fields.set(
      4,
      await signProtocolObject(
        protocolObjectFromFields(7, fields),
        signingPrivateKey,
      ),
    );
  return encodeProtocolObject(protocolObjectFromFields(7, fields));
};

describe("project epoch grant bootstrap", () => {
  test("creates a signed grant with an encrypted project key", async () => {
    const { encryption, signing, grant } = await fixture();
    const object = parseProtocolObject(grant.canonicalBytes);
    expect(object.get(1)).toBe(7);
    expect(object.get(70)).toBe(1);
    expect(grant.digest).toHaveLength(48);
    await expect(
      await verifyProtocolObject(
        object,
        object.get(4) as Uint8Array,
        signing.publicKey,
      ),
    ).toBe(true);
    const envelope = canonicalEncode(
      new Map([
        [0, object.get(0)],
        [44, object.get(44)],
        [45, object.get(45)],
        [46, object.get(46)],
        [47, object.get(47)],
        [48, object.get(48)],
        [71, object.get(71)],
        [72, object.get(72)],
      ]),
    );
    expect(await open(envelope, encryption.privateKey)).toEqual(
      grant.plaintextKey,
    );
    expect(grant.plaintextKey).toHaveLength(32);
  });

  test("wraps an existing Project epoch key to a second Device", async () => {
    const { encryption, signing, trustedSigningKeys, grant } = await fixture();
    const second = await generateEncryptionKeyPair();
    const epochKey = await openProjectEpochGrant(
      grant.canonicalBytes,
      encryption.privateKey,
      { expected: expectedFor(SENDER_DEVICE_ID), trustedSigningKeys },
    );
    const peerGrant = await createProjectEpochGrantBootstrap({
      serverProfileId: SERVER_PROFILE_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      projectEpoch: 1,
      senderDeviceId: SENDER_DEVICE_ID,
      recipientDeviceId: PEER_DEVICE_ID,
      recipientX25519PublicKey: new Uint8Array(32),
      recipientEncryptionPublicKey: second.publicKey,
      signingPrivateKey: signing.privateKey,
      plaintextKey: epochKey,
    });
    await expect(
      await openProjectEpochGrant(peerGrant.canonicalBytes, second.privateKey, {
        expected: expectedFor(PEER_DEVICE_ID),
        trustedSigningKeys,
      }),
    ).toEqual(epochKey);
  });

  test("opens a correctly signed grant with only the required context", async () => {
    const { encryption, trustedSigningKeys, grant } = await fixture();
    await expect(
      await openProjectEpochGrant(grant.canonicalBytes, encryption.privateKey, {
        expected: {
          recipientDeviceId: SENDER_DEVICE_ID,
          projectId: PROJECT_ID,
          projectEpoch: 1,
        },
        trustedSigningKeys,
      }),
    ).toEqual(grant.plaintextKey);
  });

  test("rejects a server-forged grant with an all-zero signature", async () => {
    const { encryption, trustedSigningKeys } = await fixture();
    const forged = await forgeGrant(
      encryption.publicKey,
      new Uint8Array(32).fill(0x41),
    );
    await expect(
      openProjectEpochGrant(forged, encryption.privateKey, {
        expected: expectedFor(SENDER_DEVICE_ID),
        trustedSigningKeys,
      }),
    ).rejects.toBeInstanceOf(ProjectEpochGrantVerificationError);
  });

  test("rejects a grant signed by a key outside the trust set", async () => {
    const { encryption, trustedSigningKeys } = await fixture();
    const attacker = await generateSigningKeyPair();
    const forged = await forgeGrant(
      encryption.publicKey,
      new Uint8Array(32).fill(0x41),
      attacker.privateKey,
    );
    await expect(
      openProjectEpochGrant(forged, encryption.privateKey, {
        expected: expectedFor(SENDER_DEVICE_ID),
        trustedSigningKeys,
      }),
    ).rejects.toBeInstanceOf(ProjectEpochGrantVerificationError);
    await expect(
      openProjectEpochGrant(forged, encryption.privateKey, {
        expected: expectedFor(SENDER_DEVICE_ID),
        trustedSigningKeys: [],
      }),
    ).rejects.toBeInstanceOf(ProjectEpochGrantVerificationError);
  });

  test.each([
    ["recipient Device", { recipientDeviceId: PEER_DEVICE_ID }],
    ["Project", { projectId: "66666666-6666-4666-8666-666666666666" }],
    ["epoch", { projectEpoch: 2 }],
    [
      "Server Profile",
      { serverProfileId: "77777777-7777-4777-8777-777777777777" },
    ],
    ["Team", { teamId: "88888888-8888-4888-8888-888888888888" }],
  ] as const)(
    "rejects a signed grant for another %s",
    async (_label, override) => {
      const { encryption, trustedSigningKeys, grant } = await fixture();
      await expect(
        openProjectEpochGrant(grant.canonicalBytes, encryption.privateKey, {
          expected: expectedFor(SENDER_DEVICE_ID, override),
          trustedSigningKeys,
        }),
      ).rejects.toBeInstanceOf(ProjectEpochGrantVerificationError);
    },
  );
});
