import { describe, expect, test } from "bun:test";
import {
  canonicalEncode,
  exportSigningPublicKey,
  generateSigningKeyPair,
  parseProtocolObject,
  protocolObjectFromFields,
} from "@dotrelay/contracts";
import {
  createProjectEpochKeyLink,
  createProjectEpochKeyLinkBackfill,
  missingProjectEpochKeyLinks,
  openProjectEpochKeyChain,
  openProjectEpochKeyLink,
  ProjectEpochKeyLinkError,
} from "./epoch-key-chain";

const context = {
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
};
const deviceId = "66666666-6666-4666-8666-666666666666";

const randomKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

const setup = async (epochs: number) => {
  const signing = await generateSigningKeyPair();
  const trustedSigningKeys = [await exportSigningPublicKey(signing.publicKey)];
  const keys = new Map<number, Uint8Array>();
  for (let epoch = 1; epoch <= epochs; epoch += 1) keys.set(epoch, randomKey());
  const links: Uint8Array[] = [];
  for (let fromEpoch = 1; fromEpoch < epochs; fromEpoch += 1)
    links.push(
      (
        await createProjectEpochKeyLink({
          ...context,
          fromEpoch,
          fromKey: keys.get(fromEpoch)!,
          toKey: keys.get(fromEpoch + 1)!,
          signingDeviceId: deviceId,
          signingPrivateKey: signing.privateKey,
        })
      ).canonicalBytes,
    );
  return { signing, trustedSigningKeys, keys, links };
};

// Re-signs a link after a field change, so a test isolates the check under
// test instead of tripping the signature first.
const resign = async (
  bytes: Uint8Array,
  privateKey: CryptoKey,
  change: (fields: Map<number, unknown>) => void,
): Promise<Uint8Array> => {
  const { signProtocolObject } = await import("@dotrelay/contracts");
  const fields = new Map(parseProtocolObject(bytes)) as Map<number, never>;
  fields.delete(0 as never);
  fields.delete(1 as never);
  fields.delete(2 as never);
  fields.delete(3 as never);
  fields.delete(4 as never);
  change(fields as Map<number, unknown>);
  const unsigned = protocolObjectFromFields(23, fields);
  const envelope = new Map([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]) as Map<number, never>;
  envelope.set(
    4 as never,
    (await signProtocolObject(
      protocolObjectFromFields(23, envelope),
      privateKey,
    )) as never,
  );
  return canonicalEncode(protocolObjectFromFields(23, envelope));
};

describe("project epoch key chain", () => {
  test("rebuilds every earlier epoch key from the current one", async () => {
    const { trustedSigningKeys, keys, links } = await setup(4);
    const chain = await openProjectEpochKeyChain({
      ...context,
      links: [...links].reverse(),
      currentEpoch: 4,
      currentKey: keys.get(4)!,
      trustedSigningKeys,
    });
    expect(chain.break).toBeNull();
    expect([...chain.ring.keys()].sort()).toEqual([1, 2, 3, 4]);
    for (const [epoch, key] of keys) expect(chain.ring.get(epoch)).toEqual(key);
  });

  test("a single epoch needs no links", async () => {
    const key = randomKey();
    const chain = await openProjectEpochKeyChain({
      ...context,
      links: [],
      currentEpoch: 1,
      currentKey: key,
      trustedSigningKeys: [],
    });
    expect(chain.break).toBeNull();
    expect(chain.ring.get(1)).toEqual(key);
  });

  test("stops at a gap and keeps the newer keys", async () => {
    const { trustedSigningKeys, keys, links } = await setup(4);
    const chain = await openProjectEpochKeyChain({
      ...context,
      links: [links[0]!, links[2]!],
      currentEpoch: 4,
      currentKey: keys.get(4)!,
      trustedSigningKeys,
    });
    expect(chain.break).toEqual({ toEpoch: 3, reason: "missing" });
    expect([...chain.ring.keys()].sort()).toEqual([3, 4]);
    expect(missingProjectEpochKeyLinks([links[0]!, links[2]!], 4)).toEqual([3]);
  });

  test("fails closed on two links for one epoch", async () => {
    const { signing, trustedSigningKeys, keys, links } = await setup(3);
    const rival = await createProjectEpochKeyLink({
      ...context,
      fromEpoch: 2,
      fromKey: randomKey(),
      toKey: keys.get(3)!,
      signingDeviceId: deviceId,
      signingPrivateKey: signing.privateKey,
    });
    const chain = await openProjectEpochKeyChain({
      ...context,
      links: [...links, rival.canonicalBytes],
      currentEpoch: 3,
      currentKey: keys.get(3)!,
      trustedSigningKeys,
    });
    expect(chain.break).toEqual({ toEpoch: 3, reason: "duplicate" });
    expect([...chain.ring.keys()]).toEqual([3]);
  });

  test("rejects a link signed by an untrusted key", async () => {
    const { keys, links } = await setup(2);
    const other = await generateSigningKeyPair();
    const chain = await openProjectEpochKeyChain({
      ...context,
      links,
      currentEpoch: 2,
      currentKey: keys.get(2)!,
      trustedSigningKeys: [await exportSigningPublicKey(other.publicKey)],
    });
    expect(chain.break).toEqual({ toEpoch: 2, reason: "invalid" });
    expect(chain.ring.has(1)).toBe(false);
  });

  test("rejects a link bound to another Project or Team", async () => {
    const { trustedSigningKeys, keys, links } = await setup(2);
    for (const binding of [
      { projectId: "44444444-4444-4444-8444-444444444444" },
      { teamId: "44444444-4444-4444-8444-444444444444" },
      { serverProfileId: "44444444-4444-4444-8444-444444444444" },
    ])
      await expect(
        openProjectEpochKeyLink(links[0]!, {
          ...context,
          ...binding,
          toEpoch: 2,
          toKey: keys.get(2)!,
          trustedSigningKeys,
        }),
      ).rejects.toThrow(ProjectEpochKeyLinkError);
  });

  test("the AAD binds the epochs: a re-signed link with moved epochs does not open", async () => {
    const { signing, trustedSigningKeys, keys, links } = await setup(2);
    const moved = await resign(links[0]!, signing.privateKey, (fields) => {
      fields.set(62, 2);
      fields.set(63, 3);
    });
    await expect(
      openProjectEpochKeyLink(moved, {
        ...context,
        toEpoch: 3,
        toKey: keys.get(2)!,
        trustedSigningKeys,
      }),
    ).rejects.toThrow("link does not open");
  });

  test("a wrong to-epoch key does not open the link", async () => {
    const { trustedSigningKeys, links } = await setup(2);
    await expect(
      openProjectEpochKeyLink(links[0]!, {
        ...context,
        toEpoch: 2,
        toKey: randomKey(),
        trustedSigningKeys,
      }),
    ).rejects.toThrow("link does not open");
  });

  test("a link served for the wrong epoch is rejected", async () => {
    const { trustedSigningKeys, keys, links } = await setup(3);
    await expect(
      openProjectEpochKeyLink(links[0]!, {
        ...context,
        toEpoch: 3,
        toKey: keys.get(3)!,
        trustedSigningKeys,
      }),
    ).rejects.toThrow("not contiguous");
  });

  test("ignores bytes that are not a link", async () => {
    const { trustedSigningKeys, keys, links } = await setup(2);
    const chain = await openProjectEpochKeyChain({
      ...context,
      links: [new Uint8Array([1, 2, 3]), ...links],
      currentEpoch: 2,
      currentKey: keys.get(2)!,
      trustedSigningKeys,
    });
    expect(chain.break).toBeNull();
  });

  test("backfills only gaps whose two keys are known", async () => {
    const { signing, trustedSigningKeys, keys } = await setup(4);
    const known = new Map(keys);
    known.delete(1);
    const created = await createProjectEpochKeyLinkBackfill({
      ...context,
      links: [],
      currentEpoch: 4,
      knownKeys: known,
      signingDeviceId: deviceId,
      signingPrivateKey: signing.privateKey,
    });
    expect(created.map((link) => link.toEpoch)).toEqual([3, 4]);
    const chain = await openProjectEpochKeyChain({
      ...context,
      links: created.map((link) => link.canonicalBytes),
      currentEpoch: 4,
      currentKey: keys.get(4)!,
      trustedSigningKeys,
    });
    expect(chain.break).toEqual({ toEpoch: 2, reason: "missing" });
    expect(chain.ring.get(2)).toEqual(keys.get(2)!);
  });

  test("the link object has the registered shape", async () => {
    const { links } = await setup(2);
    const object = parseProtocolObject(links[0]!);
    expect(object.get(1)).toBe(23);
    expect(object.get(62)).toBe(1);
    expect(object.get(63)).toBe(2);
    expect(object.get(71)).toBe(32);
    expect(object.get(72)).toBe(48);
  });
});
