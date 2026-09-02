import { describe, expect, test } from "bun:test";
import {
  exportSigningPublicKey,
  generateSigningKeyPair,
  parseProtocolObject,
} from "@dotrelay/contracts";
import {
  createDeviceEnrollmentApproval,
  createDeviceEnrollmentRequest,
  verifyDeviceEnrollmentApproval,
} from "../index";

const ids = Object.freeze({
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  initiatorDeviceId: "33333333-3333-4333-8333-333333333333",
  newDeviceId: "44444444-4444-4444-8444-444444444444",
  approverDeviceId: "55555555-5555-4555-8555-555555555555",
});

describe("dual-control Device enrollment", () => {
  test("builds a signed request and independently signed approval", async () => {
    const initiator = await generateSigningKeyPair();
    const approver = await generateSigningKeyPair();
    const request = await createDeviceEnrollmentRequest({
      ...ids,
      deviceId: ids.newDeviceId,
      origin: "https://profile.example.test",
      identityGeneration: 4,
      initiatorSigningPrivateKey: initiator.privateKey,
      initiatorSigningPublicKey: await exportSigningPublicKey(
        initiator.publicKey,
      ),
      expiresAtMs: Date.now() + 60_000,
    });
    const transcript = parseProtocolObject(request.transcriptBytes);
    expect(transcript.get(1)).toBe(4);
    expect(transcript.get(10)).toEqual(
      new Uint8Array(Buffer.from(ids.newDeviceId.replaceAll("-", ""), "hex")),
    );
    const approval = await createDeviceEnrollmentApproval({
      request,
      approverDeviceId: ids.approverDeviceId,
      approverSigningPrivateKey: approver.privateKey,
    });
    const verified = await verifyDeviceEnrollmentApproval(
      approval.canonicalBytes,
      {
        transcriptBytes: request.transcriptBytes,
        serverProfileId: ids.serverProfileId,
        userId: ids.userId,
        enrolledDeviceId: ids.newDeviceId,
        initiatorDeviceId: ids.initiatorDeviceId,
        approverDeviceId: ids.approverDeviceId,
        initiatorSigningPublicKey: await exportSigningPublicKey(
          initiator.publicKey,
        ),
        approverSigningPublicKey: await exportSigningPublicKey(
          approver.publicKey,
        ),
      },
    );
    expect(verified.enrollmentId).toBe(request.ids.enrollmentId);
    expect(verified.transcriptHash).toEqual(request.transcriptHash);
    expect(parseProtocolObject(request.certificateBytes).get(1)).toBe(2);
  });

  test("rejects an approval signed by the initiator", async () => {
    const initiator = await generateSigningKeyPair();
    const request = await createDeviceEnrollmentRequest({
      ...ids,
      deviceId: ids.newDeviceId,
      origin: "https://profile.example.test",
      identityGeneration: 1,
      initiatorSigningPrivateKey: initiator.privateKey,
      initiatorSigningPublicKey: await exportSigningPublicKey(
        initiator.publicKey,
      ),
      expiresAtMs: Date.now() + 60_000,
    });
    await expect(
      createDeviceEnrollmentApproval({
        request,
        approverDeviceId: ids.initiatorDeviceId,
        approverSigningPrivateKey: initiator.privateKey,
      }),
    ).rejects.toThrow("must differ from initiator");
  });
});
