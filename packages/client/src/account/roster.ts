import {
  bytesToUuid,
  type CborValue,
  canonicalEncode,
  encodeProtocolObject,
  MAX_ROSTER_DEVICES,
  type ProtocolObject,
  parseProtocolObject,
  protocolObjectFromFields,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import { isSignedByTrustedKey } from "../trust/verify";
import type { AccountSigningKey } from "./account-identity";

// The Account Device roster (ADR 0015): the User's Devices, signed by the
// account signing key. Kind 24.
export const ACCOUNT_DEVICE_ROSTER_KIND = 24;

export type RosterDevice = Readonly<{
  readonly deviceId: string;
  /** Raw 32-byte X25519 public key. */
  readonly encryptionPublicKey: Uint8Array;
  /** Raw 32-byte Ed25519 public key. */
  readonly signingPublicKey: Uint8Array;
  readonly addedAtMs: number;
  /** Set only for a revoked Device. */
  readonly revokedAtMs?: number;
}>;

export type AccountDeviceRoster = Readonly<{
  readonly userId: string;
  readonly version: number;
  readonly identity: Uint8Array;
  readonly createdAtMs: number;
  readonly devices: readonly RosterDevice[];
}>;

export class AccountRosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountRosterError";
  }
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const entryFields = (device: RosterDevice): CborValue =>
  new Map<number, CborValue>([
    [10, uuidToBytes(device.deviceId)],
    [32, device.addedAtMs],
    [39, new Uint8Array(device.encryptionPublicKey)],
    [41, new Uint8Array(device.signingPublicKey)],
    [79, device.revokedAtMs === undefined ? 2 : 3],
    ...(device.revokedAtMs === undefined
      ? []
      : ([[100, device.revokedAtMs]] as Array<[number, CborValue]>)),
  ]);

export const createAccountDeviceRoster = async (
  input: Readonly<{
    readonly serverProfileId: string;
    readonly userId: string;
    readonly version: number;
    readonly devices: readonly RosterDevice[];
    readonly signingKey: AccountSigningKey;
    readonly createdAtMs?: number;
  }>,
): Promise<
  Readonly<{ objectId: string; canonicalBytes: Uint8Array; digest: Uint8Array }>
> => {
  if (!Number.isSafeInteger(input.version) || input.version < 1)
    throw new TypeError("roster version must be a positive integer");
  if (input.devices.length > MAX_ROSTER_DEVICES)
    throw new TypeError("roster lists too many Devices");
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.serverProfileId)],
    [9, uuidToBytes(input.userId)],
    [32, input.createdAtMs ?? Date.now()],
    [41, new Uint8Array(input.signingKey.identity)],
    [98, input.version],
    [
      99,
      [...input.devices]
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
        .map(entryFields),
    ],
  ]);
  const unsigned = protocolObjectFromFields(ACCOUNT_DEVICE_ROSTER_KIND, fields);
  const envelope = new Map<number, CborValue>([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  envelope.set(
    4,
    await signProtocolObject(
      protocolObjectFromFields(ACCOUNT_DEVICE_ROSTER_KIND, envelope),
      input.signingKey.privateKey,
    ),
  );
  const canonicalBytes = encodeProtocolObject(
    protocolObjectFromFields(ACCOUNT_DEVICE_ROSTER_KIND, envelope),
  );
  return Object.freeze({
    objectId: crypto.randomUUID(),
    canonicalBytes,
    digest: await sha384(canonicalBytes),
  });
};

const bytes = (map: ReadonlyMap<number, unknown>, field: number) => {
  const value = map.get(field);
  if (!(value instanceof Uint8Array))
    throw new AccountRosterError(`roster field ${field} is missing`);
  return new Uint8Array(value);
};

const uint = (map: ReadonlyMap<number, unknown>, field: number) => {
  const value = map.get(field);
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number))
    throw new AccountRosterError(`roster field ${field} is missing`);
  return number;
};

const decode = (object: ProtocolObject): AccountDeviceRoster => {
  const entries = object.get(99);
  if (!Array.isArray(entries))
    throw new AccountRosterError("roster entries are missing");
  return Object.freeze({
    userId: bytesToUuid(bytes(object, 9)),
    version: uint(object, 98),
    identity: bytes(object, 41),
    createdAtMs: uint(object, 32),
    devices: Object.freeze(
      entries.map((entry) => {
        if (!(entry instanceof Map))
          throw new AccountRosterError("roster entry is malformed");
        return Object.freeze({
          deviceId: bytesToUuid(bytes(entry, 10)),
          encryptionPublicKey: bytes(entry, 39),
          signingPublicKey: bytes(entry, 41),
          addedAtMs: uint(entry, 32),
          ...(entry.has(100) ? { revokedAtMs: uint(entry, 100) } : {}),
        });
      }),
    ),
  });
};

// Reads a roster's claims without trusting them; use only to learn the
// identity it claims before deciding whether to pin it.
export const readAccountDeviceRoster = (
  canonicalBytes: Uint8Array,
): AccountDeviceRoster => {
  let object: ProtocolObject;
  try {
    object = parseProtocolObject(canonicalBytes);
  } catch {
    throw new AccountRosterError("roster is malformed");
  }
  if (object.get(1) !== ACCOUNT_DEVICE_ROSTER_KIND)
    throw new AccountRosterError("object is not an Account Device roster");
  return decode(object);
};

// Verifies a roster against an identity the caller already trusts (derived
// from its own AMK, or pinned for a teammate) and the expected bindings.
export const verifyAccountDeviceRoster = async (
  canonicalBytes: Uint8Array,
  expected: Readonly<{
    readonly serverProfileId: string;
    readonly userId: string;
    readonly identity: Uint8Array;
  }>,
): Promise<AccountDeviceRoster> => {
  const object = (() => {
    try {
      return parseProtocolObject(canonicalBytes);
    } catch {
      throw new AccountRosterError("roster is malformed");
    }
  })();
  if (object.get(1) !== ACCOUNT_DEVICE_ROSTER_KIND)
    throw new AccountRosterError("object is not an Account Device roster");
  if (
    !sameBytes(bytes(object, 8), uuidToBytes(expected.serverProfileId)) ||
    !sameBytes(bytes(object, 9), uuidToBytes(expected.userId))
  )
    throw new AccountRosterError("roster is bound to another User");
  if (!sameBytes(bytes(object, 41), expected.identity))
    throw new AccountRosterError("roster names another account identity");
  if (!(await isSignedByTrustedKey(object, [expected.identity])))
    throw new AccountRosterError("roster signature does not verify");
  return decode(object);
};
