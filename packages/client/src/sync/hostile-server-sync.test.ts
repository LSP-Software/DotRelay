import { describe, expect, test } from "bun:test";
import {
  type CborValue,
  canonicalEncode,
  encodeProtocolObject,
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  InvalidCiphertextError,
  parseProtocolObject,
  protocolObjectFromFields,
  type SyncPageWire,
  type SyncRevisionWire,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import { ProtocolVerificationError } from "../trust/verify";
import {
  createPublicationArtifacts,
  decodeSyncManifest,
  decodeSyncVariables,
  openLane,
  type PublicationContext,
  type PublicationVariable,
  type StagedPublicationObject,
  verifySyncPage,
} from "./publication";

// Regression tests for the malicious Server Profile cases of the November
// 2026 internal review: each one plays the service and hands the client
// hostile but well-formed protocol objects.

const ids = {
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  environmentId: "44444444-4444-4444-8444-444444444444",
};
const userA = "55555555-5555-4555-8555-555555555555";
const userC = "77777777-7777-4777-8777-777777777777";
const deviceA = "66666666-6666-4666-8666-666666666666";
const deviceC = "88888888-8888-4888-8888-888888888888";
const genesis = { id: ids.environmentId, digest: new Uint8Array(48) };
const fromGenesis = {
  expectedTrustedRevisionId: ids.environmentId,
  expectedTrustedRevisionHash: new Uint8Array(48),
} as const;

const wireRevision = async (
  staged: readonly StagedPublicationObject[],
  revisionObjectId: string,
  revisionId: string,
  parent: Readonly<{ id: string; digest: Uint8Array }>,
): Promise<SyncRevisionWire> => {
  const object = staged.find(
    (candidate) => candidate.objectId === revisionObjectId,
  );
  if (!object) throw new Error("revision object is missing");
  const revision = parseProtocolObject(object.bytes);
  return {
    id: revisionId,
    digest: await sha384(object.bytes),
    parentId: parent.id,
    parentHash: parent.digest,
    mutation: revision.get(35) as number,
    projectEpoch: BigInt(revision.get(30) as number),
    authoredAtMs: BigInt(revision.get(34) as number),
    rollbackTargetId: null,
    objects: await Promise.all(
      staged.map(async (candidate) => ({
        objectId: candidate.objectId,
        canonicalBytes: candidate.bytes,
        digest: await sha384(candidate.bytes),
      })),
    ),
  };
};

const pageOf = (revisions: readonly SyncRevisionWire[]): SyncPageWire => {
  const head = revisions.at(-1);
  return {
    environmentId: ids.environmentId,
    trustedRevisionId: genesis.id,
    trustedRevisionHash: genesis.digest,
    currentHeadId: head?.id ?? null,
    currentHeadHash: head?.digest ?? null,
    projectEpoch: head?.projectEpoch ?? 1n,
    revisions,
    nextCursor: null,
  };
};

const actor = async (userId: string, deviceId: string) => {
  const signing = await generateSigningKeyPair();
  const encryption = await generateEncryptionKeyPair();
  return {
    userId,
    deviceId,
    signing,
    encryption,
    signingPublicKey: await exportSigningPublicKey(signing.publicKey),
    userValueKey: crypto.getRandomValues(new Uint8Array(32)),
  };
};

const publish = async (
  author: Awaited<ReturnType<typeof actor>>,
  variables: readonly PublicationVariable[],
  overrides: Partial<PublicationContext> & {
    readonly parent: Readonly<{ id: string; digest: Uint8Array }>;
  },
) => {
  const { parent, ...context } = overrides;
  const first = parent.id === genesis.id;
  const artifacts = await createPublicationArtifacts(variables, {
    ...ids,
    actorUserId: author.userId,
    actorDeviceId: author.deviceId,
    projectEpoch: 1,
    expectedHeadId: first ? null : parent.id,
    expectedHeadHash: first ? null : parent.digest,
    valueRecipientPublicKey: author.encryption.publicKey,
    userDefinedValueRecipientPublicKey: author.encryption.publicKey,
    userDefinedValueSecret: author.userValueKey,
    signingPrivateKey: author.signing.privateKey,
    mutation: first ? "GENESIS" : "MANIFEST_UPDATE",
    ...context,
  });
  return {
    artifacts,
    wire: await wireRevision(
      artifacts.stagedObjects,
      artifacts.request.revision.protocolObjectId,
      artifacts.request.revision.id,
      parent,
    ),
  };
};

const variable = (
  overrides: Partial<PublicationVariable> & { readonly id: string },
): PublicationVariable => ({
  name: "DATABASE_URL",
  description: "",
  ownership: "SHARED_VALUE",
  value: "postgres://value",
  required: true,
  hasDraftChange: true,
  ...overrides,
});

describe("C-4: a Project epoch never goes backwards", () => {
  test("verifySyncPage rejects a Revision whose epoch is lower than its parent's", async () => {
    const author = await actor(userA, deviceA);
    const epochOneKey = crypto.getRandomValues(new Uint8Array(32));
    const epochTwoKey = crypto.getRandomValues(new Uint8Array(32));
    const id = "99999999-9999-4999-8999-999999999991";
    const rotated = await publish(
      author,
      [variable({ id, value: "postgres://old" })],
      { parent: genesis, projectEpoch: 2, sharedValueSecret: epochTwoKey },
    );
    // The service, colluding with a removed Member who holds the epoch-1
    // key, gets the next publication sealed under the pre-rotation key.
    const stale = await publish(
      author,
      [variable({ id, value: "postgres://new-secret" })],
      {
        parent: rotated.wire,
        projectEpoch: 1,
        sharedValueSecret: epochOneKey,
      },
    );
    await expect(
      verifySyncPage(
        pageOf([rotated.wire, stale.wire]),
        author.signingPublicKey,
        fromGenesis,
      ),
    ).rejects.toBeInstanceOf(ProtocolVerificationError);
  });

  test("verifySyncPage rejects a first Revision older than the trusted point's epoch", async () => {
    const author = await actor(userA, deviceA);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const first = await publish(
      author,
      [variable({ id: "99999999-9999-4999-8999-999999999992" })],
      { parent: genesis, projectEpoch: 1, sharedValueSecret: key },
    );
    await expect(
      verifySyncPage(pageOf([first.wire]), author.signingPublicKey, {
        ...fromGenesis,
        trustedRevisionProjectEpoch: 2n,
      }),
    ).rejects.toBeInstanceOf(ProtocolVerificationError);
  });

  test("createPublicationArtifacts refuses to publish below the verified head's epoch", async () => {
    const author = await actor(userA, deviceA);
    await expect(
      createPublicationArtifacts(
        [variable({ id: "99999999-9999-4999-8999-999999999993" })],
        {
          ...ids,
          actorUserId: author.userId,
          actorDeviceId: author.deviceId,
          projectEpoch: 1,
          parentProjectEpoch: 2,
          expectedHeadId: "99999999-9999-4999-8999-999999999994",
          expectedHeadHash: new Uint8Array(48).fill(1),
          valueRecipientPublicKey: author.encryption.publicKey,
          sharedValueSecret: crypto.getRandomValues(new Uint8Array(32)),
          signingPrivateKey: author.signing.privateKey,
          mutation: "MANIFEST_UPDATE",
        },
      ),
    ).rejects.toThrow("older Project epoch");
  });
});

describe("C-5: a User-defined Value ciphertext is bound to its context", () => {
  const teamB = {
    teamId: "abababab-abab-4bab-8bab-abababababab",
    projectId: "acacacac-acac-4cac-8cac-acacacacacac",
    environmentId: "adadadad-adad-4dad-8dad-adadadadadad",
  };

  // Copies the victim's ciphertext into a lane object the service built for
  // another Team, Project and Environment, keeping the Variable and Revision
  // ids, and signs it with a key the service controls.
  const relocate = async (
    laneBytes: Uint8Array,
    overrides: ReadonlyArray<readonly [number, CborValue]> = [],
  ) => {
    const lane = parseProtocolObject(laneBytes);
    const signing = await generateSigningKeyPair();
    const fields = new Map<number, CborValue>([
      [8, uuidToBytes(ids.serverProfileId)],
      [11, uuidToBytes(teamB.teamId)],
      [13, uuidToBytes(teamB.projectId)],
      [14, uuidToBytes(teamB.environmentId)],
      [17, uuidToBytes(crypto.randomUUID())],
      [18, uuidToBytes(crypto.randomUUID())],
      [30, 1],
      [36, 4],
      ...([15, 16, 26, 46, 47, 48, 50, 69, 71, 72] as const).flatMap(
        (field): Array<[number, CborValue]> =>
          lane.has(field) ? [[field, lane.get(field) as CborValue]] : [],
      ),
      ...overrides,
    ]);
    const unsigned = protocolObjectFromFields(13, fields);
    const envelope = new Map<number, CborValue>([
      ...fields,
      [3, canonicalEncode(unsigned)],
      [4, new Uint8Array(64)],
    ]);
    envelope.set(
      4,
      await signProtocolObject(
        protocolObjectFromFields(13, envelope),
        signing.privateKey,
      ),
    );
    return encodeProtocolObject(protocolObjectFromFields(13, envelope));
  };

  test("a Team A User-defined Value does not open inside a Team B lane", async () => {
    const victim = await actor(userA, deviceA);
    const published = await publish(
      victim,
      [
        variable({
          id: "99999999-9999-4999-8999-999999999995",
          name: "TOKEN",
          ownership: "USER_DEFINED_VALUE",
          value: "team-a-secret",
        }),
      ],
      {
        parent: genesis,
        sharedValueSecret: crypto.getRandomValues(new Uint8Array(32)),
      },
    );
    const valueLane = published.artifacts.stagedObjects.find(
      (object) => parseProtocolObject(object.bytes).get(36) === 4,
    );
    if (!valueLane) throw new Error("User-defined Value lane is missing");
    // Sanity: the genuine lane opens with the victim's User Value Key.
    expect(
      new TextDecoder().decode(
        await openLane(
          valueLane.bytes,
          victim.encryption.privateKey,
          victim.userValueKey,
        ),
      ),
    ).toBe("team-a-secret");
    for (const relocated of [
      await relocate(valueLane.bytes),
      // Downgrading the relocated lane to the legacy layout must not help.
      await relocate(valueLane.bytes, [[50, 1]]),
    ])
      await expect(
        openLane(relocated, victim.encryption.privateKey, victim.userValueKey),
      ).rejects.toBeInstanceOf(InvalidCiphertextError);
  });

  test("a Revision may carry Value lanes only for its own author", async () => {
    const author = await actor(userA, deviceA);
    const other = await actor(userC, deviceC);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const published = await publish(
      author,
      [
        variable({
          id: "99999999-9999-4999-8999-999999999996",
          name: "TOKEN",
          ownership: "USER_DEFINED_VALUE",
          value: "author-value",
        }),
        variable({
          id: "99999999-9999-4999-8999-999999999997",
          name: "SHARED",
          value: "shared-value",
        }),
      ],
      { parent: genesis, sharedValueSecret: key },
    );
    // The honest Revision verifies.
    await verifySyncPage(pageOf([published.wire]), author.signingPublicKey, {
      ...fromGenesis,
      actorUserId: other.userId,
    });
    // The author's Device re-signed lanes that name another User as the
    // owner (scope 4) or provider (scope 3); field 22 still names the
    // author. The Revision is refused instead of attributing the lane.
    for (const [scope, field] of [
      [4, 26],
      [3, 27],
    ] as const) {
      const mismatched = await resignRevision(
        published.artifacts.stagedObjects,
        published.artifacts.request.revision.protocolObjectId,
        published.artifacts.request.revision.id,
        genesis,
        author.signing.privateKey,
        (lane) =>
          lane.get(36) === scope
            ? new Map([...lane, [field, uuidToBytes(other.userId)]])
            : lane,
      );
      await expect(
        verifySyncPage(pageOf([mismatched]), author.signingPublicKey, {
          ...fromGenesis,
          actorUserId: userA,
        }),
      ).rejects.toBeInstanceOf(ProtocolVerificationError);
    }
  });

  test("the decoder never opens another owner's User-defined Value lane with this User's key", async () => {
    const victim = await actor(userC, deviceC);
    const member = await actor(userA, deviceA);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const id = "99999999-9999-4999-8999-999999999998";
    // The member publishes a Value lane they own, but the service swapped
    // in a ciphertext the victim's User Value Key opens.
    const published = await publish(
      member,
      [
        variable({
          id,
          name: "TOKEN",
          ownership: "USER_DEFINED_VALUE",
          value: "member-value",
        }),
      ],
      {
        parent: genesis,
        sharedValueSecret: key,
        userDefinedValueSecret: victim.userValueKey,
      },
    );
    const decoded = await decodeSyncVariables(
      pageOf([published.wire]),
      () => victim.encryption.privateKey,
      [],
      key,
      victim.userId,
      victim.userValueKey,
    );
    const token = decoded.find((entry) => entry.id === id);
    expect(token?.ownerUserId).toBe(member.userId);
    expect(token?.value).toBeNull();
  });
});

const signFields = async (
  kind: number,
  fields: ReadonlyMap<number, CborValue>,
  signingPrivateKey: CryptoKey,
): Promise<Uint8Array> => {
  // Fields 0-2 come from protocolObjectFromFields; 3 and 4 are re-signed.
  const body = new Map([...fields].filter(([field]) => field > 4));
  const unsigned = protocolObjectFromFields(kind, body);
  const envelope = new Map<number, CborValue>([
    ...body,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  envelope.set(
    4,
    await signProtocolObject(
      protocolObjectFromFields(kind, envelope),
      signingPrivateKey,
    ),
  );
  return encodeProtocolObject(protocolObjectFromFields(kind, envelope));
};

// Rebuilds a published Revision after `transform` rewrites its lane objects,
// re-signing every lane, the commitments, the descriptor and the Revision
// with `signingPrivateKey`, the way a Device that went rogue could.
const resignRevision = async (
  staged: readonly StagedPublicationObject[],
  revisionObjectId: string,
  revisionId: string,
  parent: Readonly<{ id: string; digest: Uint8Array }>,
  signingPrivateKey: CryptoKey,
  transform: (lane: Map<number, CborValue>) => Map<number, CborValue>,
): Promise<SyncRevisionWire> => {
  const rebuilt: StagedPublicationObject[] = [];
  const laneHashes = new Map<
    string,
    Readonly<{ hash: Uint8Array; lane: ReadonlyMap<number, CborValue> }>
  >();
  for (const object of staged) {
    const parsed = parseProtocolObject(object.bytes);
    if (parsed.get(1) !== 13) continue;
    const lane = transform(new Map(parsed));
    const bytes = await signFields(13, lane, signingPrivateKey);
    laneHashes.set(Buffer.from(lane.get(18) as Uint8Array).toString("hex"), {
      hash: await sha384(bytes),
      lane,
    });
    rebuilt.push({ objectId: object.objectId, bytes });
  }
  const revisionObject = staged.find(
    (object) => object.objectId === revisionObjectId,
  );
  if (!revisionObject) throw new Error("revision object is missing");
  const revision = new Map(parseProtocolObject(revisionObject.bytes));
  const commitments = (revision.get(53) as Array<Map<number, CborValue>>).map(
    (commitment) => {
      const entry = laneHashes.get(
        Buffer.from(commitment.get(18) as Uint8Array).toString("hex"),
      );
      if (!entry) return commitment;
      const next = new Map(commitment);
      next.set(48, entry.hash);
      for (const field of [26, 27]) {
        if (entry.lane.has(field))
          next.set(field, entry.lane.get(field) as CborValue);
        else next.delete(field);
      }
      return next;
    },
  );
  const descriptorObject = staged.find(
    (object) => parseProtocolObject(object.bytes).get(1) === 15,
  );
  if (!descriptorObject) throw new Error("descriptor is missing");
  const descriptor = new Map(parseProtocolObject(descriptorObject.bytes));
  descriptor.set(53, commitments);
  const descriptorBytes = await signFields(15, descriptor, signingPrivateKey);
  rebuilt.push({ objectId: descriptorObject.objectId, bytes: descriptorBytes });
  revision.set(51, descriptorBytes);
  revision.set(52, await sha384(descriptorBytes));
  revision.set(53, commitments);
  rebuilt.push({
    objectId: revisionObjectId,
    bytes: await signFields(16, revision, signingPrivateKey),
  });
  return wireRevision(rebuilt, revisionObjectId, revisionId, parent);
};

describe("C-6: the decoder uses the descriptor the Revision commits to", () => {
  const scenario = async () => {
    const a = await actor(userA, deviceA);
    const c = await actor(userC, deviceC);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const id = "99999999-9999-4999-8999-99999999999a";
    const token = (value: string, description = "") =>
      variable({
        id,
        name: "TOKEN",
        description,
        ownership: "USER_DEFINED_VALUE",
        value,
        required: false,
      });
    const r1 = await publish(a, [token("a-value")], {
      parent: genesis,
      sharedValueSecret: key,
    });
    const r2 = await publish(c, [token("c-value")], {
      parent: r1.wire,
      sharedValueSecret: key,
    });
    // R3 changes only the description, so it carries no Value lane.
    const r3 = await publish(
      a,
      [{ ...token("", "now documented"), value: null }],
      {
        parent: r2.wire,
        sharedValueSecret: key,
      },
    );
    const keys = [a.signingPublicKey, c.signingPublicKey];
    // The service withholds A's lanes from C, as it must.
    const forC = (wire: SyncRevisionWire): SyncRevisionWire => ({
      ...wire,
      objects: wire.objects.filter((object) => {
        const parsed = parseProtocolObject(object.canonicalBytes);
        return !(
          parsed.get(1) === 13 &&
          parsed.get(36) === 4 &&
          wire.id !== r2.wire.id
        );
      }),
    });
    const r1Descriptor = r1.wire.objects.find(
      (object) => parseProtocolObject(object.canonicalBytes).get(1) === 15,
    );
    if (!r1Descriptor) throw new Error("descriptor is missing");
    const injected: SyncRevisionWire = {
      ...forC(r3.wire),
      objects: [r1Descriptor, ...forC(r3.wire).objects],
    };
    return {
      a,
      c,
      key,
      id,
      keys,
      honest: pageOf([forC(r1.wire), r2.wire, forC(r3.wire)]),
      injected: pageOf([forC(r1.wire), r2.wire, injected]),
    };
  };

  test("an honest page shows C their own Value", async () => {
    const { c, key, id, keys, honest } = await scenario();
    await verifySyncPage(honest, keys, {
      ...fromGenesis,
      actorUserId: c.userId,
    });
    const decoded = await decodeSyncVariables(
      honest,
      () => c.encryption.privateKey,
      [],
      key,
      c.userId,
      c.userValueKey,
    );
    expect(decoded.find((entry) => entry.id === id)).toMatchObject({
      value: "c-value",
      ownerUserId: c.userId,
    });
  });

  test("verifySyncPage rejects a Revision carrying a second Manifest descriptor", async () => {
    const { c, keys, injected } = await scenario();
    await expect(
      verifySyncPage(injected, keys, {
        ...fromGenesis,
        actorUserId: c.userId,
      }),
    ).rejects.toBeInstanceOf(ProtocolVerificationError);
  });

  test("the decoder reads the descriptor named by the Revision's Manifest hash", async () => {
    const { c, key, id, injected } = await scenario();
    const decoded = await decodeSyncManifest(
      injected,
      () => c.encryption.privateKey,
      [],
      key,
      c.userId,
      c.userValueKey,
    );
    expect(decoded.variables.find((entry) => entry.id === id)).toMatchObject({
      value: "c-value",
      ownerUserId: c.userId,
    });
  });
});
