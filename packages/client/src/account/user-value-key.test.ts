import { describe, expect, test } from "bun:test";
import {
  encodeProtocolObject,
  exportSigningPublicKey,
  generateSigningKeyPair,
} from "@dotrelay/contracts";
import { createAccountKeyEnvelope, generateAccountMasterKey } from "./index";
import {
  authenticatedCreatorKeys,
  openOwnedUserValueKey,
  USER_VALUE_KEY_GENERATION,
} from "./user-value-key";

const SERVER_PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = new Uint8Array(16).fill(7);
const DEVICE_ID = new Uint8Array(16).fill(9);

const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("creator keys claimed beside an account-key object", () => {
  test("ignores a substituted creator key that is not in device trust history", async () => {
    const owner = await generateSigningKeyPair();
    const attacker = await generateSigningKeyPair();
    const ownerKey = hex(await exportSigningPublicKey(owner.publicKey));
    const attackerKey = hex(await exportSigningPublicKey(attacker.publicKey));
    const accountMasterKey = generateAccountMasterKey();
    const contentKey = new Uint8Array(32).fill(4);
    const substituted = await createAccountKeyEnvelope({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      createdAtMs: 1_700_000_000_000,
      accountMasterKey,
      signingPrivateKey: attacker.privateKey,
      kind: {
        type: "userValueKey",
        ownerUserId: USER_ID,
        valueGeneration: USER_VALUE_KEY_GENERATION,
        contentKey,
      },
    });
    const claimed = authenticatedCreatorKeys([attackerKey], [ownerKey]);
    expect(claimed).toEqual([]);
    const opened = await openOwnedUserValueKey(
      encodeProtocolObject(substituted.object),
      accountMasterKey,
      {
        trustedKeys: { keys: [await exportSigningPublicKey(owner.publicKey)] },
        context: { userId: USER_ID },
        ownerUserId: USER_ID,
      },
    );
    expect(opened).toBeNull();
  });

  test("opens a User Value Key signed by a key already in device trust history", async () => {
    const owner = await generateSigningKeyPair();
    const attacker = await generateSigningKeyPair();
    const ownerPublic = await exportSigningPublicKey(owner.publicKey);
    const ownerKey = hex(ownerPublic);
    const attackerKey = hex(await exportSigningPublicKey(attacker.publicKey));
    const accountMasterKey = generateAccountMasterKey();
    const contentKey = new Uint8Array(32).fill(5);
    const envelope = await createAccountKeyEnvelope({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      createdAtMs: 1_700_000_000_000,
      accountMasterKey,
      signingPrivateKey: owner.privateKey,
      kind: {
        type: "userValueKey",
        ownerUserId: USER_ID,
        valueGeneration: USER_VALUE_KEY_GENERATION,
        contentKey,
      },
    });
    expect(
      authenticatedCreatorKeys([attackerKey, ownerKey], [ownerKey]),
    ).toEqual([ownerKey]);
    const opened = await openOwnedUserValueKey(
      encodeProtocolObject(envelope.object),
      accountMasterKey,
      {
        trustedKeys: { keys: [ownerPublic] },
        context: { userId: USER_ID },
        ownerUserId: USER_ID,
      },
    );
    expect(opened).toEqual(contentKey);
  });

  test("does not open a project epoch envelope or another generation as the User Value Key", async () => {
    const owner = await generateSigningKeyPair();
    const ownerPublic = await exportSigningPublicKey(owner.publicKey);
    const accountMasterKey = generateAccountMasterKey();
    const project = await createAccountKeyEnvelope({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      createdAtMs: 1_700_000_000_000,
      accountMasterKey,
      signingPrivateKey: owner.privateKey,
      kind: {
        type: "projectEpochKey",
        projectId: new Uint8Array(16).fill(3),
        projectEpoch: 1,
        contentKey: new Uint8Array(32).fill(8),
      },
    });
    const otherGeneration = await createAccountKeyEnvelope({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      createdAtMs: 1_700_000_000_000,
      accountMasterKey,
      signingPrivateKey: owner.privateKey,
      kind: {
        type: "userValueKey",
        ownerUserId: USER_ID,
        valueGeneration: USER_VALUE_KEY_GENERATION + 1,
        contentKey: new Uint8Array(32).fill(9),
      },
    });
    const input = {
      trustedKeys: { keys: [ownerPublic] },
      context: { userId: USER_ID },
      ownerUserId: USER_ID,
    };
    expect(
      await openOwnedUserValueKey(
        encodeProtocolObject(project.object),
        accountMasterKey,
        input,
      ),
    ).toBeNull();
    expect(
      await openOwnedUserValueKey(
        encodeProtocolObject(otherGeneration.object),
        accountMasterKey,
        input,
      ),
    ).toBeNull();
  });
});
