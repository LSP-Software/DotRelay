export {};

const primitives = (await Bun.file(
  "test-vectors/e2ee/v3/rfc-primitives.json",
).json()) as {
  sources: Array<{ algorithm: string }>;
  acvpReferences?: unknown;
};

if (primitives.acvpReferences !== undefined)
  throw new Error("v3 vectors must not contain post-quantum ACVP references");

const algorithms = new Set(
  primitives.sources.map((source) => source.algorithm),
);
for (const algorithm of ["X25519", "Ed25519", "SHA-384"])
  if (!algorithms.has(algorithm))
    throw new Error(`missing ${algorithm} fixture`);

console.log("✓ verified v3 classical protocol sources");
