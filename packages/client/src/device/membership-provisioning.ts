import {
  type CborValue,
  canonicalEncode,
  encodeProtocolObject,
  protocolObjectFromFields,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import { createProjectEpochGrantBootstrap } from "./grant-bootstrap";

export type MembershipProvisioningPlan = Readonly<{
  teamId: string;
  membershipId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  projects: readonly Readonly<{
    id: string;
    epoch: number;
    environmentId: string;
  }>[];
  devices: readonly Readonly<{ id: string; encryptionPublicKey: string }>[];
}>;

export const createMembershipProvisioning = async (
  input: Readonly<{
    serverProfileId: string;
    deviceId: string;
    signingPrivateKey: CryptoKey;
    plan: MembershipProvisioningPlan;
    projectKeys: ReadonlyMap<string, Uint8Array>;
  }>,
) => {
  const operationId = crypto.randomUUID();
  const grants: Array<{ objectId: string; object: string }> = [];
  const references: CborValue[] = [];
  const toBase64 = (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  for (const project of input.plan.projects) {
    const key = input.projectKeys.get(project.id);
    if (key?.length !== 32) throw new Error("Project key is unavailable");
    for (const device of input.plan.devices) {
      if (!/^[0-9a-f]{64}$/i.test(device.encryptionPublicKey))
        throw new Error("Recipient key is invalid");
      const publicBytes = Uint8Array.from(
        device.encryptionPublicKey.match(/../g) ?? [],
        (value) => Number.parseInt(value, 16),
      );
      const publicKey = await crypto.subtle.importKey(
        "raw",
        publicBytes,
        { name: "X25519" },
        true,
        [],
      );
      const grant = await createProjectEpochGrantBootstrap({
        serverProfileId: input.serverProfileId,
        teamId: input.plan.teamId,
        projectId: project.id,
        projectEpoch: project.epoch,
        senderDeviceId: input.deviceId,
        recipientDeviceId: device.id,
        recipientX25519PublicKey: publicBytes,
        recipientEncryptionPublicKey: publicKey,
        signingPrivateKey: input.signingPrivateKey,
        plaintextKey: key,
      });
      grant.plaintextKey.fill(0);
      grants.push({
        objectId: grant.objectId,
        object: toBase64(grant.canonicalBytes),
      });
      references.push(
        new Map<number, CborValue>([
          [13, uuidToBytes(project.id)],
          [25, uuidToBytes(device.id)],
          [30, project.epoch],
          [48, grant.digest],
        ]),
      );
    }
  }
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.serverProfileId)],
    [9, uuidToBytes(input.plan.userId)],
    [11, uuidToBytes(input.plan.teamId)],
    [12, uuidToBytes(input.plan.membershipId)],
    [17, uuidToBytes(operationId)],
    [23, uuidToBytes(input.deviceId)],
    [32, Date.now()],
    [55, input.plan.devices.map((device) => uuidToBytes(device.id))],
    [56, references],
    [78, { OWNER: 1, ADMIN: 2, MEMBER: 3 }[input.plan.role]],
  ]);
  const unsigned = protocolObjectFromFields(6, fields);
  fields.set(3, canonicalEncode(unsigned));
  fields.set(4, new Uint8Array(64));
  fields.set(
    4,
    await signProtocolObject(
      protocolObjectFromFields(6, fields),
      input.signingPrivateKey,
    ),
  );
  return {
    operationId,
    activation: {
      objectId: crypto.randomUUID(),
      object: toBase64(
        encodeProtocolObject(protocolObjectFromFields(6, fields)),
      ),
    },
    grants,
  };
};
