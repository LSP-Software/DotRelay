import { describe, expect, test } from "bun:test";
import { protocolObjectFromFields } from "@dotrelay/contracts";
import {
  createDevicePrivateBundle,
  encodeDevicePrivateBundle,
  loadDeviceKeyMaterial,
  parseDevicePrivateBundle,
} from "./bundle";

const pin = Object.freeze({
  serverProfileId: "00000000-0000-0000-0000-000000000001",
  origin: "https://profile.example.test",
});

describe("device private bundle", () => {
  test("round-trips through canonical encoding", async () => {
    const userId = new Uint8Array(16).fill(9);
    const deviceId = new Uint8Array(16).fill(10);
    const bundle = await createDevicePrivateBundle({
      pin,
      userId,
      deviceId,
      userIdentityGeneration: 1,
    });
    const parsed = parseDevicePrivateBundle(
      encodeDevicePrivateBundle(bundle),
      pin,
    );
    expect(parsed.deviceId).toEqual(deviceId);
    expect(parsed.userIdentityGeneration).toBe(1);
    const keys = await loadDeviceKeyMaterial(parsed);
    expect(keys.encryptionPrivateKey.type).toBe("private");
    expect(keys.signingPrivateKey.type).toBe("private");
  });

  test("accepts frozen v3 vector object-18", async () => {
    const fixturePath = new URL(
      "../../../../test-vectors/e2ee/v3/objects.json",
      import.meta.url,
    );
    const fixture = (await Bun.file(fixturePath).json()) as {
      vectors: { id: string; canonicalHex: string }[];
    };
    const vector = fixture.vectors.find((entry) => entry.id === "object-18");
    expect(vector).toBeDefined();
    const bytes = Uint8Array.from(
      (vector?.canonicalHex.match(/.{1,2}/g) ?? []).map((part) =>
        Number.parseInt(part, 16),
      ),
    );
    const vectorPin = Object.freeze({
      serverProfileId: "00000000-0000-0000-0000-000000000000",
      origin: "https://profile.example.test",
    });
    const parsed = parseDevicePrivateBundle(bytes, vectorPin);
    expect(parsed.object.get(1)).toBe(18);
    expect(parsed.userIdentityGeneration).toBe(1);
  });

  test("rejects malformed bundle bytes", () => {
    expect(() => parseDevicePrivateBundle(new Uint8Array([0]), pin)).toThrow();
  });

  test("rejects a bundle from another server profile", async () => {
    const bundle = await createDevicePrivateBundle({
      pin,
      userId: new Uint8Array(16),
      deviceId: new Uint8Array(16),
      userIdentityGeneration: 0,
    });
    expect(() =>
      parseDevicePrivateBundle(encodeDevicePrivateBundle(bundle), {
        ...pin,
        serverProfileId: "00000000-0000-0000-0000-000000000002",
      }),
    ).toThrow("server profile mismatch");
  });
});

describe("device bundle key import", () => {
  test("rejects invalid private key material", async () => {
    const object = protocolObjectFromFields(
      18,
      new Map([
        [8, new Uint8Array(16)],
        [9, new Uint8Array(16)],
        [10, new Uint8Array(16)],
        [28, 1],
        [80, new Uint8Array([4, 5, 6])],
        [81, new Uint8Array([7, 8, 9])],
      ]),
    );
    await expect(
      loadDeviceKeyMaterial({
        object,
        pin,
        userId: new Uint8Array(16),
        deviceId: new Uint8Array(16),
        userIdentityGeneration: 1,
      }),
    ).rejects.toThrow();
  });
});
