import { describe, expect, test } from "bun:test";
import { parseProtocolObject } from "@dotrelay/contracts";
import {
  createDeviceBootstrap,
  loadDeviceKeyMaterial,
  verifySignedProtocolObject,
} from "../index";

describe("browser Device bootstrap", () => {
  test("creates a signed certificate and a locally recoverable key bundle", async () => {
    const bootstrap = await createDeviceBootstrap({
      pin: {
        serverProfileId: "11111111-1111-4111-8111-111111111111",
        origin: "https://relay.example",
      },
      userId: "22222222-2222-4222-8222-222222222222",
    });
    const certificate = parseProtocolObject(
      bootstrap.certificate.canonicalBytes,
    );
    expect(certificate.get(1)).toBe(2);
    expect(certificate.get(10)).toEqual(
      new Uint8Array(
        bootstrap.deviceId
          .replaceAll("-", "")
          .match(/../g)
          ?.map((byte) => Number.parseInt(byte, 16)),
      ),
    );
    await verifySignedProtocolObject(
      bootstrap.certificate.canonicalBytes,
      bootstrap.ed25519PublicKey,
    );
    const material = await loadDeviceKeyMaterial(bootstrap.bundle);
    expect(material.encryptionPublicKey).toBeDefined();
    expect(material.signingPublicKey).toBeDefined();
  });
});
