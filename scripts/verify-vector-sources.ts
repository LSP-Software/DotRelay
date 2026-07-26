import { hexFromBytes } from "./vector-hex";

type AcvpReference = Readonly<{
  readonly id: string;
  readonly url: string;
  readonly sourceRevision: string;
  readonly sha256: string;
}>;

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  hexFromBytes(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  );

const verifyReference = async (reference: AcvpReference): Promise<void> => {
  const response = await fetch(reference.url, { redirect: "error" });
  if (!response.ok)
    throw new Error(`could not retrieve ${reference.id}: ${response.status}`);
  const source = new Uint8Array(await response.arrayBuffer());
  const digest = await sha256Hex(source);
  if (digest !== reference.sha256)
    throw new Error(`digest mismatch for ${reference.id}`);
};

const primitives = (await Bun.file(
  "test-vectors/e2ee/v2/rfc-primitives.json",
).json()) as { acvpReferences: AcvpReference[] };

for (const reference of primitives.acvpReferences) {
  if (!reference.url.includes(`/${reference.sourceRevision}/`))
    throw new Error(`unpinned source URL for ${reference.id}`);
  await verifyReference(reference);
}

console.log(
  `✓ verified ${primitives.acvpReferences.length} pinned ACVP sources`,
);
