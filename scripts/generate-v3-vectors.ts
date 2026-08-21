import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  canonicalEncode,
  ENUM_REGISTRIES,
  FIXED_LENGTHS,
  SUITE_NAME,
  SUITE_VALUE,
} from "@dotrelay/contracts";
import { NEGATIVE_VECTOR_CASES, VECTOR_CASES } from "./vector-fixtures";

const directory = "test-vectors/e2ee/v3";
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytesFromHex = (value: string): Uint8Array =>
  new Uint8Array(
    value.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
const sha384Hex = async (value: Uint8Array): Promise<string> =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-384", value as Uint8Array<ArrayBuffer>),
    ),
  );
const hmacSha384 = async (
  keyBytes: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as Uint8Array<ArrayBuffer>,
    { hash: "SHA-384", name: "HMAC" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, data as Uint8Array<ArrayBuffer>),
  );
};
const hkdfSha384Fixture = async (): Promise<Record<string, unknown>> => {
  const ikm = bytesFromHex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
  const salt = bytesFromHex("000102030405060708090a0b0c");
  const info = bytesFromHex("f0f1f2f3f4f5f6f7f8f9");
  const length = 42;
  const prk = await hmacSha384(salt, ikm);
  const blocks: Uint8Array[] = [];
  let previous: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let produced = 0;
  for (let counter = 1; produced < length; counter++) {
    previous = await hmacSha384(
      prk,
      new Uint8Array([...previous, ...info, counter]),
    );
    blocks.push(previous);
    produced += previous.length;
  }
  const okm = new Uint8Array(
    blocks.flatMap((block) => [...block]).slice(0, length),
  );
  return {
    id: "rfc-5869-a.1-sha-384",
    url: "https://www.rfc-editor.org/rfc/rfc5869#appendix-A.1",
    algorithm: "HKDF-SHA-384",
    input: { ikmHex: hex(ikm), saltHex: hex(salt), infoHex: hex(info), length },
    intermediates: { prkHex: hex(prk) },
    output: { okmHex: hex(okm) },
  };
};

const vectors = VECTOR_CASES.map((vector) => ({
  id: vector.id,
  kind: vector.kind,
  canonicalHex: hex(canonicalEncode(vector.object)),
  unsignedBodyHex: hex(
    canonicalEncode(
      new Map(
        [...vector.object.entries()].filter(
          ([field]) => ![3, 4].includes(field),
        ),
      ),
    ),
  ),
}));

const objects = vectors.filter((vector) => vector.id.startsWith("object-"));
const conditional = vectors.filter(
  (vector) => !vector.id.startsWith("object-"),
);
const positive = {
  suite: SUITE_NAME,
  suiteValue: SUITE_VALUE,
  encoding: "deterministic-cbor",
  immutable: true,
  objectVectors: "objects.json",
  conditionalVectors: "conditional.json",
  objects: objects.map(({ id, kind }) => ({ id, kind })),
  enumCoverage: Object.fromEntries(
    Object.entries(ENUM_REGISTRIES).map(([name, values]) => [
      name,
      Object.keys(values).map(Number),
    ]),
  ),
};

const primitives = JSON.parse(
  await readFile("test-vectors/e2ee/v2/primitives.json", "utf8"),
) as Record<string, unknown>;
const encoder = new TextEncoder();
const domainSeparators = [
  "DotRelay\0dotrelay-e2ee-v3-classical-webcrypto\0Signature\0v1\0",
  "DotRelay\0dotrelay-e2ee-v3-classical-webcrypto\0AES-256-GCM\0v1",
].map(async (value) => ({
  id: value.includes("Signature")
    ? "signature-input-prefix"
    : "hkdf-info-label",
  utf8Hex: hex(encoder.encode(value)),
  sha384Hex: await sha384Hex(encoder.encode(value)),
}));
const v3Primitives = {
  ...primitives,
  suite: SUITE_NAME,
  suiteValue: SUITE_VALUE,
  fixedLengths: FIXED_LENGTHS,
  domainSeparators: await Promise.all(domainSeparators),
};

const rfcPrimitives = JSON.parse(
  await readFile("test-vectors/e2ee/v2/rfc-primitives.json", "utf8"),
) as Record<string, unknown>;
const { acvpReferences: _acvpReferences, ...providerNeutralRfcPrimitives } =
  rfcPrimitives;
const v3RfcPrimitives = {
  ...providerNeutralRfcPrimitives,
  suite: SUITE_NAME,
  suiteValue: SUITE_VALUE,
  sources: [
    await hkdfSha384Fixture(),
    ...(
      providerNeutralRfcPrimitives.sources as Array<Record<string, unknown>>
    ).filter(
      (source) =>
        !String(source.algorithm).startsWith("ML-") &&
        source.algorithm !== "HKDF-SHA-256",
    ),
  ],
  algorithms: ["X25519", "Ed25519", "HKDF-SHA-384", "AES-256-GCM", "SHA-384"],
};

const browserBun = {
  suite: SUITE_NAME,
  immutable: true,
  fixtures: [
    { id: "cbor-map-order", hex: "a2000201636f6e65" },
    { id: "cbor-empty-map", hex: "a0" },
    { id: "cbor-uint64-shortest", hex: "1b0000000100000000" },
  ],
};

await mkdir(directory, { recursive: true });
const files: Record<string, string> = {
  "objects.json": json({
    suite: SUITE_NAME,
    encoding: "deterministic-cbor",
    immutable: true,
    vectors: objects,
  }),
  "conditional.json": json({
    suite: SUITE_NAME,
    encoding: "deterministic-cbor",
    immutable: true,
    vectors: conditional,
  }),
  "positive.json": json(positive),
  "negative.json": json({
    suite: SUITE_NAME,
    suiteValue: SUITE_VALUE,
    immutable: true,
    cases: NEGATIVE_VECTOR_CASES.map((vector) => ({
      id: vector.id,
      hex: hex(vector.bytes),
      error: vector.error,
    })),
  }),
  "primitives.json": json(v3Primitives),
  "rfc-primitives.json": json(v3RfcPrimitives),
  "browser-bun.json": json(browserBun),
};
for (const [name, contents] of Object.entries(files))
  await writeFile(`${directory}/${name}`, contents);

const formatter = Bun.spawn(
  ["bun", "x", "biome", "format", directory, "--write"],
  {
    stderr: "inherit",
    stdout: "ignore",
  },
);
if ((await formatter.exited) !== 0)
  throw new Error("Biome failed while formatting the v3 vector corpus");

const manifestFiles = await Promise.all(
  Object.keys(files)
    .sort()
    .map(async (path) => ({
      path,
      sha384: await sha384Hex(
        new Uint8Array(await readFile(`${directory}/${path}`)),
      ),
    })),
);
await writeFile(
  `${directory}/manifest.json`,
  json({
    suite: SUITE_NAME,
    suiteValue: SUITE_VALUE,
    immutable: true,
    hash: "sha-384",
    files: manifestFiles,
  }),
);
