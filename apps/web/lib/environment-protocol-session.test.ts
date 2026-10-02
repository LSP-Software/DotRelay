import { expect, test } from "bun:test";
import {
  createPublicationArtifacts,
  openLane,
  type ProtocolTransport,
} from "@dotrelay/client";
import {
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  InvalidCiphertextError,
  parseProtocolObject,
} from "@dotrelay/contracts";
import { createEnvironmentProtocolSession } from "./environment-protocol-session";

const ids = {
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  environmentId: "44444444-4444-4444-8444-444444444444",
  actorUserId: "55555555-5555-4555-8555-555555555555",
  actorDeviceId: "66666666-6666-4666-8666-666666666666",
};

test("a browser rollback is sealed with the Project epoch key another Device holds", async () => {
  const browser = await generateEncryptionKeyPair();
  const cli = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const epochKey = crypto.getRandomValues(new Uint8Array(32));
  const variableId = "77777777-7777-4777-8777-777777777777";
  // The workspace resolves the epoch key after building the publication
  // context and passes it only as the session read key. Publish must still
  // seal with that key.
  const session = createEnvironmentProtocolSession({
    context: {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: ids.environmentId,
      expectedHeadHash: new Uint8Array(48),
      valueRecipientPublicKey: browser.publicKey,
      userDefinedValueRecipientPublicKey: browser.publicKey,
      signingPrivateKey: signing.privateKey,
      revisionSigningPublicKey: await exportSigningPublicKey(signing.publicKey),
    },
    transport: {} as ProtocolTransport,
    sharedValuePrivateKey: browser.privateKey,
    sharedValueSecret: epochKey,
  });
  const artifacts = await createPublicationArtifacts(
    [
      {
        id: variableId,
        name: "DATABASE_URL",
        description: "Connection string",
        ownership: "SHARED_VALUE",
        value: "postgres://rolled-back",
        required: true,
        hasDraftChange: true,
      },
    ],
    {
      ...session.context,
      mutation: "ROLLBACK",
      rollbackTargetId: ids.environmentId,
      rollbackSelectedVariableIds: [variableId],
    },
  );
  const valueLane = artifacts.stagedObjects.find((staged) => {
    const object = parseProtocolObject(staged.bytes);
    return object.get(1) === 13 && object.get(36) === 3;
  });
  if (!valueLane) throw new Error("rollback value lane is missing");
  await expect(
    openLane(valueLane.bytes, cli.privateKey),
  ).rejects.toBeInstanceOf(InvalidCiphertextError);
  expect(
    new TextDecoder().decode(
      await openLane(valueLane.bytes, cli.privateKey, epochKey),
    ),
  ).toBe("postgres://rolled-back");
});
