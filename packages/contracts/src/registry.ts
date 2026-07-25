import type { CborValue } from "./cbor";

export const SUITE_NAME = "dotrelay-e2ee-v2" as const;
export const SUITE_VALUE = 2 as const;
export const API_VERSION = "v1" as const;

export type FieldType = "uint" | "bytes" | "array" | "map" | "any";
export type FieldDefinition = Readonly<{
  readonly name: string;
  readonly type: FieldType;
  readonly exactLength?: number;
  readonly maxLength?: number;
}>;

const field = (
  name: string,
  type: FieldType,
  options?: { exactLength?: number; maxLength?: number },
): FieldDefinition => Object.freeze({ name, type, ...options });

export const FIELD_REGISTRY: Readonly<Record<number, FieldDefinition>> =
  Object.freeze({
    0: field("suite", "uint"),
    1: field("object kind", "uint"),
    2: field("object schema version", "uint"),
    3: field("exact unsigned-body bytes", "bytes", {
      maxLength: 64 * 1024 * 1024,
    }),
    4: field("primary ML-DSA signature", "bytes", { exactLength: 3309 }),
    5: field("primary Ed25519 signature", "bytes", { exactLength: 64 }),
    6: field("successor ML-DSA signature", "bytes", { exactLength: 3309 }),
    7: field("successor Ed25519 signature", "bytes", { exactLength: 64 }),
    8: field("Server Profile id", "bytes", { exactLength: 16 }),
    9: field("User id", "bytes", { exactLength: 16 }),
    10: field("Device id", "bytes", { exactLength: 16 }),
    11: field("Team id", "bytes", { exactLength: 16 }),
    12: field("Membership id", "bytes", { exactLength: 16 }),
    13: field("Project id", "bytes", { exactLength: 16 }),
    14: field("Environment id", "bytes", { exactLength: 16 }),
    15: field("Variable id", "bytes", { exactLength: 16 }),
    16: field("Revision id", "bytes", { exactLength: 16 }),
    17: field("Correlation ID", "bytes", { exactLength: 16 }),
    18: field("object id", "bytes", { exactLength: 16 }),
    19: field("parent Revision id", "bytes", { exactLength: 16 }),
    20: field("parent Revision hash", "bytes", { exactLength: 48 }),
    21: field("Rollback target Revision id", "bytes", { exactLength: 16 }),
    22: field("author User id", "bytes", { exactLength: 16 }),
    23: field("signing Device id", "bytes", { exactLength: 16 }),
    24: field("sender Device id", "bytes", { exactLength: 16 }),
    25: field("recipient Device id", "bytes", { exactLength: 16 }),
    26: field("owner User id", "bytes", { exactLength: 16 }),
    27: field("original-provider User id", "bytes", { exactLength: 16 }),
    28: field("User identity generation", "uint"),
    29: field("recovery generation", "uint"),
    30: field("Project epoch", "uint"),
    31: field("User-defined Value generation", "uint"),
    32: field("created-at Unix milliseconds", "uint"),
    33: field("expires-at Unix milliseconds", "uint"),
    34: field("authored-at Unix milliseconds", "uint"),
    35: field("mutation kind", "uint"),
    36: field("lane scope", "uint"),
    37: field("key kind", "uint"),
    38: field("ML-KEM public key", "bytes", { exactLength: 1184 }),
    39: field("X25519 public key", "bytes", { exactLength: 32 }),
    40: field("ML-DSA public key", "bytes", { exactLength: 1952 }),
    41: field("Ed25519 public key", "bytes", { exactLength: 32 }),
    42: field("predecessor hash", "bytes", { exactLength: 48 }),
    43: field("four-key public identity", "bytes", { exactLength: 3200 }),
    44: field("ML-KEM ciphertext", "bytes", { exactLength: 1088 }),
    45: field("X25519 ciphertext", "bytes", { exactLength: 32 }),
    46: field("XChaCha20 nonce", "bytes", { exactLength: 24 }),
    47: field("ciphertext", "bytes", { maxLength: 64 * 1024 * 1024 }),
    48: field("ciphertext hash", "bytes", { exactLength: 48 }),
    49: field("reserved and forbidden", "any"),
    50: field("Manifest schema version", "uint"),
    51: field("Manifest descriptor bytes", "bytes", {
      maxLength: 64 * 1024 * 1024,
    }),
    52: field("Manifest hash", "bytes", { exactLength: 48 }),
    53: field("lane commitments", "array"),
    54: field("affected lanes", "array"),
    55: field("complete recipient set", "array"),
    56: field("grant references", "array"),
    57: field("challenge", "bytes", { exactLength: 32 }),
    58: field("challenge hash", "bytes", { exactLength: 48 }),
    59: field("recovery-envelope id", "bytes", { exactLength: 16 }),
    60: field("recovery-envelope hash", "bytes", { exactLength: 48 }),
    61: field("wrapped key material", "bytes", { maxLength: 4096 }),
    62: field("previous Project epoch", "uint"),
    63: field("new Project epoch", "uint"),
    64: field("expected-head Revision id", "bytes", { exactLength: 16 }),
    65: field("expected-head Revision hash", "bytes", { exactLength: 48 }),
    66: field("new-head Revision id", "bytes", { exactLength: 16 }),
    67: field("new-head Revision hash", "bytes", { exactLength: 48 }),
    68: field("Rollback-selected lanes", "array"),
    69: field("authorization routing", "map"),
    70: field("grant kind", "uint"),
    71: field("declared plaintext length", "uint"),
    72: field("declared ciphertext length", "uint"),
    73: field("service accepted-at milliseconds", "uint"),
    74: field("predecessor identity", "bytes", { exactLength: 3200 }),
    75: field("successor identity", "bytes", { exactLength: 3200 }),
    76: field("enrollment transcript hash", "bytes", { exactLength: 48 }),
    77: field("approval Device id", "bytes", { exactLength: 16 }),
    78: field("Membership role", "uint"),
    79: field("archival/lifecycle state", "uint"),
    80: field("ML-KEM private seed", "bytes", { exactLength: 64 }),
    81: field("X25519 private input", "bytes", { exactLength: 32 }),
    82: field("ML-DSA private seed", "bytes", { exactLength: 32 }),
    83: field("Ed25519 private seed", "bytes", { exactLength: 32 }),
    84: field("HKDF purpose code", "uint"),
    85: field("HKDF context hash", "bytes", { exactLength: 48 }),
  });

export const ENUM_REGISTRIES = Object.freeze({
  mutationKind: Object.freeze({
    1: "genesis",
    2: "Manifest update",
    3: "Rollback",
    4: "epoch transition",
    5: "User-key rotation",
  }),
  laneScope: Object.freeze({
    1: "Environment definition",
    2: "Variable definition",
    3: "Shared Value",
    4: "User-defined Value",
  }),
  keyKind: Object.freeze({
    1: "Project Epoch Key",
    2: "User-defined Value Key",
    3: "User trust bundle",
  }),
  grantKind: Object.freeze({
    1: "current Project epoch",
    2: "historical Project epoch",
    3: "current User-defined Value generation",
    4: "historical User-defined Value generation",
    5: "Device trust provisioning",
    6: "recovery Project key",
    7: "recovery User-defined Value key",
  }),
  membershipRole: Object.freeze({ 1: "owner", 2: "admin", 3: "member" }),
  lifecycle: Object.freeze({
    1: "pending Device",
    2: "active",
    3: "revoked Device",
    4: "pending-key-grant Membership",
    5: "removed Membership",
    6: "archived resource",
  }),
});

export type ObjectDefinition = Readonly<{
  readonly name: string;
  readonly requiredFields: readonly number[];
  readonly allowedFields: readonly number[];
  readonly serverVisible: boolean;
}>;

const objectDefinition = (
  name: string,
  requiredFields: readonly number[],
  allowedFields: readonly number[] = requiredFields,
  serverVisible = true,
): ObjectDefinition =>
  Object.freeze({
    name,
    requiredFields: Object.freeze([...requiredFields]),
    allowedFields: Object.freeze([...allowedFields]),
    serverVisible,
  });

const signed = (fields: readonly number[]): number[] => [
  ...new Set([...fields, 3, 4, 5]),
];
const range = (start: number, end: number): number[] =>
  Array.from({ length: end - start + 1 }, (_, index) => start + index);

const kindDefinitions: Record<number, ObjectDefinition> = {
  1: objectDefinition(
    "User identity",
    [0, 1, 2, 8, 9, 28, 32, 43],
    [0, 1, 2, 8, 9, 28, 32, 43],
    false,
  ),
  2: objectDefinition(
    "Device certificate",
    [0, 1, 2, 8, 9, 10, 17, 28, 32, 43],
    signed([0, 1, 2, 8, 9, 10, 17, 28, 32, 43, 79]),
  ),
  3: objectDefinition(
    "User identity rollover",
    [0, 1, 2, 8, 9, 17, 32, 42, 74, 75],
    signed([0, 1, 2, 8, 9, 17, 32, 42, 74, 75, 6, 7]),
  ),
  4: objectDefinition(
    "Device enrollment transcript",
    [0, 1, 2, 8, 9, 10, 17, 32, 33, 43, 57],
    signed([0, 1, 2, 8, 9, 10, 17, 32, 33, 43, 57]),
  ),
  5: objectDefinition(
    "Device enrollment approval",
    [0, 1, 2, 8, 9, 10, 17, 32, 76, 77],
    signed([0, 1, 2, 8, 9, 10, 17, 32, 76, 77]),
  ),
  6: objectDefinition(
    "Membership activation",
    [0, 1, 2, 8, 9, 11, 12, 17, 23, 32, 55, 56, 78],
    signed([0, 1, 2, 8, 9, 11, 12, 17, 23, 32, 55, 56, 78]),
  ),
  7: objectDefinition(
    "Project key grant",
    [
      0, 1, 2, 8, 11, 13, 17, 24, 25, 30, 37, 38, 39, 44, 45, 46, 47, 48, 70,
      71, 72,
    ],
    signed([
      0, 1, 2, 8, 11, 13, 17, 24, 25, 30, 37, 38, 39, 44, 45, 46, 47, 48, 70,
      71, 72,
    ]),
  ),
  8: objectDefinition(
    "User-defined Value key grant",
    [
      0, 1, 2, 8, 11, 13, 17, 24, 25, 30, 37, 38, 39, 44, 45, 46, 47, 48, 70,
      71, 72, 9, 26, 31,
    ],
    signed([
      0, 1, 2, 8, 11, 13, 17, 24, 25, 30, 37, 38, 39, 44, 45, 46, 47, 48, 70,
      71, 72, 9, 26, 31,
    ]),
  ),
  9: objectDefinition(
    "Recovery grant",
    [0, 1, 2, 8, 9, 13, 17, 24, 37, 38, 39, 44, 45, 46, 47, 48, 59, 70, 71, 72],
    signed([
      0, 1, 2, 8, 9, 13, 17, 24, 28, 29, 30, 31, 37, 38, 39, 40, 41, 42, 43, 44,
      45, 46, 47, 48, 59, 70, 71, 72,
    ]),
  ),
  10: objectDefinition(
    "Recovery envelope",
    [0, 1, 2, 8, 9, 17, 28, 29, 32, 38, 39, 40, 41, 46, 47, 48, 59, 71, 72],
    signed([
      0, 1, 2, 8, 9, 17, 28, 29, 32, 38, 39, 40, 41, 46, 47, 48, 59, 71, 72,
    ]),
  ),
  11: objectDefinition(
    "Recovery plaintext bundle",
    [0, 1, 2, 8, 9, 28, 29, 80, 81, 82, 83],
    [0, 1, 2, 8, 9, 28, 29, 80, 81, 82, 83],
    false,
  ),
  12: objectDefinition(
    "Epoch transition",
    [0, 1, 2, 8, 11, 13, 17, 23, 32, 55, 56, 62, 63, 64, 65, 66, 67],
    signed([0, 1, 2, 8, 11, 13, 17, 23, 32, 55, 56, 62, 63, 64, 65, 66, 67]),
  ),
  13: objectDefinition(
    "Ciphertext lane object",
    [0, 1, 2, 8, 11, 13, 30, 36, 46, 47, 48, 50, 69, 71, 72],
    signed([
      0, 1, 2, 8, 11, 13, 14, 15, 16, 17, 18, 26, 27, 30, 31, 36, 46, 47, 48,
      50, 69, 71, 72,
    ]),
  ),
  14: objectDefinition(
    "Lane commitment",
    [0, 1, 2, 18, 30, 36, 48, 69, 72],
    signed([0, 1, 2, 14, 15, 16, 18, 26, 27, 30, 31, 36, 48, 69, 72]),
  ),
  15: objectDefinition(
    "Manifest descriptor",
    [0, 1, 2, 8, 11, 13, 14, 16, 30, 50, 53],
    signed([0, 1, 2, 8, 11, 13, 14, 16, 30, 50, 53]),
  ),
  16: objectDefinition(
    "Revision",
    [
      0, 1, 2, 8, 11, 13, 14, 16, 17, 19, 20, 22, 23, 30, 34, 35, 50, 51, 52,
      53, 54,
    ],
    signed([
      0, 1, 2, 8, 11, 13, 14, 16, 17, 19, 20, 22, 23, 30, 34, 35, 50, 51, 52,
      53, 54, 21, 68,
    ]),
  ),
  17: objectDefinition(
    "Recovery challenge proof",
    [0, 1, 2, 8, 9, 10, 17, 28, 29, 32, 33, 58],
    signed([0, 1, 2, 8, 9, 10, 17, 28, 29, 32, 33, 58]),
  ),
  18: objectDefinition(
    "Device private bundle",
    [0, 1, 2, 8, 9, 10, 28, 80, 81, 82, 83],
    [0, 1, 2, 8, 9, 10, 28, 80, 81, 82, 83],
    false,
  ),
  19: objectDefinition(
    "User trust private bundle",
    [0, 1, 2, 8, 9, 28, 29, 80, 81, 82, 83],
    [0, 1, 2, 8, 9, 28, 29, 80, 81, 82, 83],
    false,
  ),
};

// Keep the ranges explicit: these are the only conditional fields permitted by each closed body.
const kind13 = kindDefinitions[13];
const kind14 = kindDefinitions[14];
const kind16 = kindDefinitions[16];
if (!kind13 || !kind14 || !kind16)
  throw new Error("incomplete object registry");
kindDefinitions[13] = objectDefinition(
  kind13.name,
  kind13.requiredFields,
  signed([
    ...new Set([
      ...range(0, 2),
      8,
      11,
      13,
      ...range(14, 18),
      26,
      27,
      30,
      36,
      46,
      47,
      48,
      50,
      69,
      71,
      72,
    ]),
  ]),
);
kindDefinitions[14] = objectDefinition(
  kind14.name,
  kind14.requiredFields,
  signed([
    ...new Set([
      ...range(0, 2),
      ...range(14, 16),
      18,
      26,
      27,
      30,
      31,
      36,
      48,
      69,
      72,
    ]),
  ]),
);
kindDefinitions[16] = objectDefinition(
  kind16.name,
  kind16.requiredFields,
  signed([...new Set([...kind16.requiredFields, 21, 68])]),
);

export const OBJECT_REGISTRY: Readonly<Record<number, ObjectDefinition>> =
  Object.freeze(kindDefinitions);

export const FIXED_LENGTHS = Object.freeze({
  mlKemPublicKey: 1184,
  mlKemPrivateSeed: 64,
  mlKemCiphertext: 1088,
  x25519: 32,
  mlDsaPublicKey: 1952,
  mlDsaPrivateSeed: 32,
  mlDsaSignature: 3309,
  ed25519: 32,
  ed25519Signature: 64,
  digest: 48,
  derivedKey: 32,
  nonce: 24,
  tag: 16,
  opaqueId: 16,
  publicIdentity: 3200,
});

export type ProtocolObject = ReadonlyMap<number, CborValue>;
