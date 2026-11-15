import { describe, expect, test } from "bun:test";
import {
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  accountFingerprint,
  deriveAccountSigningKey,
  deviceKeyFingerprint,
  formatAccountKeyTransferCode,
  parseAccountKeyTransferCode,
  sameFingerprint,
} from "./account-identity";
import {
  createAccountKeyTransfer,
  generateAccountMasterKey,
  openAccountKeyTransferWithRoster,
} from "./index";
import { createAccountDeviceRoster, type RosterDevice } from "./roster";
import { AccountKeyVerificationError } from "./verification";

const serverProfileId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const senderId = "33333333-3333-4333-8333-333333333333";
const recipientId = "44444444-4444-4444-8444-444444444444";

const device = async () => {
  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  return {
    encryption,
    signing,
    encryptionPublicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", encryption.publicKey),
    ),
    signingPublicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", signing.publicKey),
    ),
  };
};

const entry = (
  deviceId: string,
  keys: Awaited<ReturnType<typeof device>>,
  revokedAtMs?: number,
): RosterDevice => ({
  deviceId,
  encryptionPublicKey: keys.encryptionPublicKey,
  signingPublicKey: keys.signingPublicKey,
  addedAtMs: 1,
  ...(revokedAtMs === undefined ? {} : { revokedAtMs }),
});

const scenario = async () => {
  const sender = await device();
  const recipient = await device();
  const amk = generateAccountMasterKey();
  const signingKey = await deriveAccountSigningKey(amk, {
    serverProfileId,
    userId,
  });
  const rosterOf = async (devices: readonly RosterDevice[], key = amk) =>
    (
      await createAccountDeviceRoster({
        serverProfileId,
        userId,
        version: 2,
        devices,
        signingKey: await deriveAccountSigningKey(key, {
          serverProfileId,
          userId,
        }),
      })
    ).canonicalBytes;
  const transferOf = async (
    accountMasterKey = amk,
    signingPrivateKey = sender.signing.privateKey,
  ) =>
    createAccountKeyTransfer({
      serverProfileId,
      userId: uuidToBytes(userId),
      deviceId: uuidToBytes(senderId),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      accountMasterKey,
      recipientDeviceId: recipientId,
      recipientEncryptionPublicKey: recipient.encryption.publicKey,
      signingPrivateKey,
    });
  const open = async (
    transfer: Awaited<ReturnType<typeof transferOf>>,
    roster: Uint8Array | null,
    expectedIdentity: Uint8Array | null = null,
  ) =>
    openAccountKeyTransferWithRoster(
      transfer,
      recipient.encryption.privateKey,
      {
        serverProfileId,
        userId,
        device: {
          deviceId: recipientId,
          encryptionPublicKey: recipient.encryptionPublicKey,
          signingPublicKey: recipient.signingPublicKey,
        },
        nowMs: Date.now(),
        roster,
        expectedIdentity,
      },
    );
  return {
    sender,
    recipient,
    amk,
    identity: signingKey.identity,
    rosterOf,
    transferOf,
    open,
  };
};

describe("Account Key Transfer anchored in the account roster (ADR 0022)", () => {
  test("opens a transfer from a rostered sender to a rostered recipient", async () => {
    const { sender, recipient, amk, identity, rosterOf, transferOf, open } =
      await scenario();
    const roster = await rosterOf([
      entry(senderId, sender),
      entry(recipientId, recipient),
    ]);
    const opened = await open(await transferOf(), roster, identity);
    expect(opened.accountMasterKey).toEqual(amk);
    expect(opened.identity).toEqual(identity);
  });

  test("refuses a service-chosen key, a missing roster, an unlisted sender or recipient", async () => {
    const { sender, recipient, identity, rosterOf, transferOf, open } =
      await scenario();
    const attacker = await generateSigningKeyPair();
    const both = [entry(senderId, sender), entry(recipientId, recipient)];
    const forgedAmk = generateAccountMasterKey();
    const cases: Array<() => Promise<unknown>> = [
      // A key the service chose, signed by a key it controls.
      async () =>
        open(
          await transferOf(forgedAmk, attacker.privateKey),
          await rosterOf(both),
        ),
      // ...even with its own roster for that key, against a pinned identity.
      async () =>
        open(
          await transferOf(forgedAmk, sender.signing.privateKey),
          await rosterOf(both, forgedAmk),
          identity,
        ),
      // The roster is withheld.
      async () => open(await transferOf(), null),
      // The sender is not in the roster, or is revoked.
      async () =>
        open(
          await transferOf(),
          await rosterOf([entry(recipientId, recipient)]),
        ),
      async () =>
        open(
          await transferOf(),
          await rosterOf([
            entry(senderId, sender, 5),
            entry(recipientId, recipient),
          ]),
        ),
      // This Device is not in the roster yet: the roster predates the
      // handoff.
      async () =>
        open(await transferOf(), await rosterOf([entry(senderId, sender)])),
    ];
    for (const attempt of cases)
      await expect(attempt()).rejects.toBeInstanceOf(
        AccountKeyVerificationError,
      );
  });
});

describe("fingerprints and transfer codes", () => {
  test("a transfer code carries the account fingerprint", async () => {
    const { identity } = await scenario();
    const fingerprint = await accountFingerprint(identity);
    const code = formatAccountKeyTransferCode("AB".repeat(16), fingerprint);
    expect(code).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{40}$/);
    const parsed = parseAccountKeyTransferCode(code);
    expect(parsed.transferId).toBe("ab".repeat(16));
    expect(parsed.accountFingerprint).toBe(fingerprint);
    expect(sameFingerprint(parsed.accountFingerprint ?? "", fingerprint)).toBe(
      true,
    );
    expect(
      parseAccountKeyTransferCode("ab".repeat(16)).accountFingerprint,
    ).toBe(null);
    expect(() =>
      parseAccountKeyTransferCode("ab".repeat(16) + ".zz"),
    ).toThrow();
  });

  test("a Device fingerprint covers both public keys", async () => {
    const one = await device();
    const two = await device();
    const fingerprint = await deviceKeyFingerprint(one);
    expect(fingerprint).toMatch(/^([0-9a-f]{8} ){4}[0-9a-f]{8}$/);
    expect(
      await deviceKeyFingerprint({
        encryptionPublicKey: one.encryptionPublicKey,
        signingPublicKey: two.signingPublicKey,
      }),
    ).not.toBe(fingerprint);
  });
});
