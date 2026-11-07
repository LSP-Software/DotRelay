import { describe, expect, test } from "bun:test";
import { canonicalEncode, type CborValue } from "./cbor";
import { PROJECT_EPOCH_KEY_LINK_KDF_INFO } from "./crypto";
import { ContractError } from "./errors";
import {
  encodeProtocolObject,
  parseProtocolObject,
  protocolObjectFromFields,
} from "./protocol";
import { OBJECT_REGISTRY } from "./registry";

// Project Epoch Key Link (ADR 0014): kind 23 seals the epoch-n key under the
// epoch-(n+1) key.
const link = (
  changes: ReadonlyMap<number, CborValue> = new Map(),
  removed: readonly number[] = [],
) => {
  const fields = new Map<number, CborValue>([
    [8, new Uint8Array(16).fill(1)],
    [11, new Uint8Array(16).fill(2)],
    [13, new Uint8Array(16).fill(3)],
    [17, new Uint8Array(16).fill(4)],
    [23, new Uint8Array(16).fill(5)],
    [32, 1_700_000_000_000],
    [44, new Uint8Array(32).fill(6)],
    [46, new Uint8Array(12).fill(7)],
    [47, new Uint8Array(48).fill(8)],
    [48, new Uint8Array(48).fill(9)],
    [62, 1],
    [63, 2],
    [71, 32],
    [72, 48],
    ...changes,
  ]);
  for (const field of removed) fields.delete(field);
  const unsigned = protocolObjectFromFields(23, fields);
  return protocolObjectFromFields(
    23,
    new Map([
      ...fields,
      [3, canonicalEncode(unsigned)],
      [4, new Uint8Array(64)],
    ]),
  );
};

describe("Project Epoch Key Link registry entry", () => {
  test("is registered as a server-visible signed object", () => {
    expect(OBJECT_REGISTRY[23]?.name).toBe("Project Epoch Key Link");
    expect(OBJECT_REGISTRY[23]?.serverVisible).toBe(true);
  });

  test("round-trips a well-formed link", () => {
    const bytes = encodeProtocolObject(link());
    expect(parseProtocolObject(bytes).get(63)).toBe(2);
  });

  test.each([
    ["skips an epoch", new Map([[63, 3]])],
    ["goes backwards", new Map([[63, 1]])],
    [
      "starts at epoch 0",
      new Map([
        [62, 0],
        [63, 1],
      ]),
    ],
    [
      "seals a key that is not 32 bytes",
      new Map<number, CborValue>([
        [47, new Uint8Array(32)],
        [71, 16],
        [72, 32],
      ]),
    ],
  ] as const)("rejects a link that %s", (_label, changes) => {
    expect(() =>
      encodeProtocolObject(link(changes as ReadonlyMap<number, CborValue>)),
    ).toThrow(ContractError);
  });

  test.each([[62], [63], [23], [13], [44]])("requires field %d", (field) => {
    expect(() => encodeProtocolObject(link(new Map(), [field]))).toThrow(
      ContractError,
    );
  });

  test("rejects fields outside the closed body", () => {
    expect(() => encodeProtocolObject(link(new Map([[30, 1]])))).toThrow(
      ContractError,
    );
  });

  test("uses a dedicated, versioned HKDF info string", () => {
    expect(new TextDecoder().decode(PROJECT_EPOCH_KEY_LINK_KDF_INFO)).toBe(
      "DotRelay\0dotrelay-e2ee-v3-classical-webcrypto\0Project-epoch-key-link\0v1",
    );
  });
});
