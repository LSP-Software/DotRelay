import { expect, test } from "bun:test";
import {
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import { openProjectEpochGrant } from "./grant-bootstrap";
import {
  createMembershipProvisioning,
  type MembershipProvisioningPlan,
} from "./membership-provisioning";

test("provisioning shares the existing project keys with every invited Device and signs the exact set", async () => {
  const signing = await generateSigningKeyPair();
  const recipients = await Promise.all([
    generateEncryptionKeyPair(),
    generateEncryptionKeyPair(),
  ]);
  const plan: MembershipProvisioningPlan = {
    teamId: crypto.randomUUID(),
    membershipId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    role: "MEMBER",
    projects: [1, 2].map(() => ({
      id: crypto.randomUUID(),
      epoch: 1,
      environmentId: crypto.randomUUID(),
    })),
    devices: await Promise.all(
      recipients.map(async (key) => ({
        id: crypto.randomUUID(),
        encryptionPublicKey: Buffer.from(
          await crypto.subtle.exportKey("raw", key.publicKey),
        ).toString("hex"),
      })),
    ),
  };
  const projectKeys = new Map(
    plan.projects.map((project) => [
      project.id,
      crypto.getRandomValues(new Uint8Array(32)),
    ]),
  );
  const request = await createMembershipProvisioning({
    serverProfileId: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
    signingPrivateKey: signing.privateKey,
    plan,
    projectKeys,
  });
  expect(request.grants).toHaveLength(4);
  for (const [index, entry] of request.grants.entries()) {
    const raw = Uint8Array.from(Buffer.from(entry.object, "base64"));
    const object = parseProtocolObject(raw);
    expect(
      await verifyProtocolObject(
        object,
        object.get(4) as Uint8Array,
        signing.publicKey,
      ),
    ).toBe(true);
    const recipient = recipients[index % 2];
    const project = plan.projects[Math.floor(index / 2)];
    if (!recipient || !project) throw new Error("fixture incomplete");
    expect(await openProjectEpochGrant(raw, recipient.privateKey)).toEqual(
      projectKeys.get(project.id),
    );
    expect(JSON.stringify(request)).not.toContain(
      Buffer.from(projectKeys.get(project.id) ?? []).toString("base64"),
    );
  }
  const activation = parseProtocolObject(
    Uint8Array.from(Buffer.from(request.activation.object, "base64")),
  );
  expect(
    await verifyProtocolObject(
      activation,
      activation.get(4) as Uint8Array,
      signing.publicKey,
    ),
  ).toBe(true);
  expect(activation.get(55)).toHaveLength(2);
  expect(activation.get(56)).toHaveLength(4);
});
