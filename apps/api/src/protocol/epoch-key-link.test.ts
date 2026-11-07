import { describe, expect, test } from "bun:test";
import { createProjectEpochKeyLink } from "@dotrelay/client";
import { ContractError } from "@dotrelay/contracts";
import { verifyProjectEpochKeyLink } from "./staging";

const ids = {
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  actorDeviceId: "44444444-4444-4444-8444-444444444444",
};
const other = "55555555-5555-4555-8555-555555555555";

const signedLink = async () => {
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const link = await createProjectEpochKeyLink({
    serverProfileId: ids.serverProfileId,
    teamId: ids.teamId,
    projectId: ids.projectId,
    fromEpoch: 2,
    fromKey: crypto.getRandomValues(new Uint8Array(32)),
    toKey: crypto.getRandomValues(new Uint8Array(32)),
    signingDeviceId: ids.actorDeviceId,
    signingPrivateKey: keyPair.privateKey,
  });
  return {
    canonicalBytes: link.canonicalBytes,
    actorSigningPublicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", keyPair.publicKey),
    ),
  };
};

describe("service-side Project Epoch Key Link checks", () => {
  test("accepts a link the actor Device signed for this Project", async () => {
    const link = await signedLink();
    expect(await verifyProjectEpochKeyLink({ ...ids, ...link })).toEqual({
      fromEpoch: 2n,
      toEpoch: 3n,
      signingDeviceId: ids.actorDeviceId,
    });
  });

  test.each([
    ["another Server Profile", { serverProfileId: other }],
    ["another Team", { teamId: other }],
    ["another Project", { projectId: other }],
    ["another actor Device", { actorDeviceId: other }],
  ])("rejects a link bound to %s", async (_label, change) => {
    const link = await signedLink();
    await expect(
      verifyProjectEpochKeyLink({ ...ids, ...link, ...change }),
    ).rejects.toBeInstanceOf(ContractError);
  });

  test("rejects a link signed by a different key", async () => {
    const link = await signedLink();
    const stranger = await signedLink();
    await expect(
      verifyProjectEpochKeyLink({
        ...ids,
        canonicalBytes: link.canonicalBytes,
        actorSigningPublicKey: stranger.actorSigningPublicKey,
      }),
    ).rejects.toBeInstanceOf(ContractError);
  });
});
