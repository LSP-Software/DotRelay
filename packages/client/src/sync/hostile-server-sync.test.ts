import { describe, expect, test } from "bun:test";
import {
  type CborValue,
  canonicalEncode,
  decodeCiphertextEnvelope,
  encodeProtocolObject,
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  InvalidCiphertextError,
  laneAssociatedData,
  parseProtocolObject,
  protocolObjectFromFields,
  type SyncPageWire,
  type SyncRevisionWire,
  sealWithSharedSecret,
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
  type RevisionSigningTrustEntry,
  type StagedPublicationObject,
  UnreadableLaneError,
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

// ---------------------------------------------------------------------------
// ADR 0023: every lane is bound to the Revision that carries it, Revision ids
// never repeat, and legacy lanes apply only from confirmed authors. The
// signer in these tests is a teammate this client pinned on first sight.
// ---------------------------------------------------------------------------

type Actor = Awaited<ReturnType<typeof actor>>;

const userU = "99999999-aaaa-4aaa-8aaa-999999999999";
const deviceU = "99999999-bbbb-4bbb-8bbb-999999999999";

// The constrained trust entry a client builds for a roster-verified Device.
const entryFor = (who: Actor): RevisionSigningTrustEntry => ({
  publicKey: who.signingPublicKey,
  deviceId: who.deviceId,
  userId: who.userId,
  deviceActiveFromMs: 0,
  deviceActiveUntilMs: null,
  memberSinceMs: 0,
  memberUntilMs: null,
});

// Seals a lane again under the legacy (format 1) associated data, the way a
// client from before lane format 2 wrote it, and signs it with `signer`.
const toLegacyLane = async (
  laneBytes: Uint8Array,
  opener: Actor,
  secret: Uint8Array,
  signer: CryptoKey,
): Promise<Uint8Array> => {
  const plaintext = await openLane(
    laneBytes,
    opener.encryption.privateKey,
    secret,
  );
  const lane = new Map(parseProtocolObject(laneBytes));
  lane.set(50, 1);
  const envelope = decodeCiphertextEnvelope(
    await sealWithSharedSecret(plaintext, secret, laneAssociatedData(lane)),
  );
  for (const field of [46, 47, 48, 72])
    lane.set(field, envelope.get(field) as CborValue);
  lane.set(
    69,
    new Map<number, CborValue>([
      [44, envelope.get(44) as CborValue],
      [45, envelope.get(45) as CborValue],
    ]),
  );
  return signFields(13, lane, signer);
};

// Builds the descriptor and Revision objects for `lanes` (already signed),
// signed by `signer` and authored by `author`, the way a hostile signer
// assembles a Revision around lanes it did not seal.
const assembleRevision = async (input: {
  readonly signer: Actor;
  readonly author: string;
  readonly revisionId: string;
  readonly parent: Readonly<{ id: string; digest: Uint8Array }>;
  readonly authoredAtMs: number;
  readonly lanes: readonly Uint8Array[];
  readonly environmentId?: string;
}): Promise<SyncRevisionWire> => {
  const environmentId = input.environmentId ?? ids.environmentId;
  const commitments: Map<number, CborValue>[] = [];
  const staged: StagedPublicationObject[] = [];
  const variableIds = new Set<string>();
  for (const bytes of input.lanes) {
    const lane = parseProtocolObject(bytes);
    commitments.push(
      new Map<number, CborValue>([
        [18, lane.get(18) as CborValue],
        [36, lane.get(36) as CborValue],
        [48, await sha384(bytes)],
        [72, lane.get(72) as CborValue],
        ...([26, 27] as const).flatMap((field): Array<[number, CborValue]> =>
          lane.has(field) ? [[field, lane.get(field) as CborValue]] : [],
        ),
      ]),
    );
    variableIds.add(Buffer.from(lane.get(15) as Uint8Array).toString("hex"));
    staged.push({ objectId: crypto.randomUUID(), bytes });
  }
  const context = new Map<number, CborValue>([
    [8, uuidToBytes(ids.serverProfileId)],
    [11, uuidToBytes(ids.teamId)],
    [13, uuidToBytes(ids.projectId)],
    [14, uuidToBytes(environmentId)],
    [16, uuidToBytes(input.revisionId)],
    [30, 1],
  ]);
  const descriptorBytes = await signFields(
    15,
    new Map<number, CborValue>([...context, [50, 1], [53, commitments]]),
    input.signer.signing.privateKey,
  );
  staged.push({ objectId: crypto.randomUUID(), bytes: descriptorBytes });
  const revisionObjectId = crypto.randomUUID();
  const first = input.parent.id === environmentId;
  staged.push({
    objectId: revisionObjectId,
    bytes: await signFields(
      16,
      new Map<number, CborValue>([
        ...context,
        [17, uuidToBytes(crypto.randomUUID())],
        [19, uuidToBytes(input.parent.id)],
        [20, input.parent.digest],
        [22, uuidToBytes(input.author)],
        [23, uuidToBytes(input.signer.deviceId)],
        [34, input.authoredAtMs],
        [35, first ? 1 : 2],
        [50, 1],
        [51, descriptorBytes],
        [52, await sha384(descriptorBytes)],
        [53, commitments],
        [
          54,
          [...variableIds].map(
            (hex) => new Uint8Array(Buffer.from(hex, "hex")),
          ),
        ],
      ]),
      input.signer.signing.privateKey,
    ),
  });
  return wireRevision(staged, revisionObjectId, input.revisionId, input.parent);
};

const valueLaneOf = (wire: SyncRevisionWire, scope: 3 | 4): Uint8Array => {
  const lane = wire.objects.find((object) => {
    const parsed = parseProtocolObject(object.canonicalBytes);
    return parsed.get(1) === 13 && parsed.get(36) === scope;
  });
  if (!lane) throw new Error("Value lane is missing");
  return lane.canonicalBytes;
};

describe("ADR 0023: a Revision cannot carry lanes sealed for another Revision", () => {
  const passwordId = "99999999-9999-4999-8999-9999999999b1";
  const password = (value: string) =>
    variable({ id: passwordId, name: "DB_PASSWORD", value });

  // The team rotates a leaked password: R1 sets "old-password", R2 sets
  // "new-password". The provider wrote both, in the given lane format.
  const rotation = async (format: 1 | 2) => {
    const provider = await actor(userA, deviceA);
    const invented = await actor(userU, deviceU);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const legacy = async (published: Awaited<ReturnType<typeof publish>>) =>
      format === 2 ? published.wire : resealRevision(published, provider, key);
    const r1 = await legacy(
      await publish(provider, [password("old-password")], {
        parent: genesis,
        sharedValueSecret: key,
      }),
    );
    const r2 = await legacy(
      await publish(provider, [password("new-password")], {
        parent: r1,
        sharedValueSecret: key,
      }),
    );
    return { provider, invented, key, r1, r2 };
  };

  const decodePassword = async (
    page: SyncPageWire,
    viewer: Actor,
    key: Uint8Array,
  ) =>
    (
      await decodeSyncVariables(
        page,
        () => viewer.encryption.privateKey,
        [],
        key,
        viewer.userId,
        viewer.userValueKey,
      )
    ).find((entry) => entry.id === passwordId)?.value;

  test("an honest rotation verifies and decodes to the new Value", async () => {
    const { provider, key, r1, r2 } = await rotation(2);
    const page = pageOf([r1, r2]);
    await verifySyncPage(page, [entryFor(provider)], {
      ...fromGenesis,
      actorUserId: provider.userId,
    });
    expect(await decodePassword(page, provider, key)).toBe("new-password");
  });

  test("with plain keys, a Revision carrying an earlier Revision's format-2 lane is refused", async () => {
    const { provider, invented, r1, r2 } = await rotation(2);
    for (const revisionId of [crypto.randomUUID(), r1.id]) {
      // The invented User's Device signs R3, claims the real provider as
      // author, and carries R1's Value lane unchanged.
      const r3 = await assembleRevision({
        signer: invented,
        author: provider.userId,
        revisionId,
        parent: r2,
        authoredAtMs: Number(r2.authoredAtMs) + 1,
        lanes: [valueLaneOf(r1, 3)],
      });
      await expect(
        verifySyncPage(
          pageOf([r1, r2, r3]),
          [provider.signingPublicKey, invented.signingPublicKey],
          { ...fromGenesis, actorUserId: provider.userId },
        ),
      ).rejects.toBeInstanceOf(ProtocolVerificationError);
    }
  });

  test("with signing-trust entries, a re-signed legacy lane from an earlier Revision is refused", async () => {
    const { provider, invented, key, r1, r2 } = await rotation(1);
    // The provider field sits outside the format-1 associated data, so the
    // invented User can name itself and sign the lane; the ciphertext still
    // opens because field 16 keeps R1's id.
    const lane = new Map(parseProtocolObject(valueLaneOf(r1, 3)));
    lane.set(27, uuidToBytes(invented.userId));
    const relabelled = await signFields(13, lane, invented.signing.privateKey);
    expect(
      new TextDecoder().decode(
        await openLane(relabelled, provider.encryption.privateKey, key),
      ),
    ).toBe("old-password");
    for (const revisionId of [crypto.randomUUID(), r1.id]) {
      const r3 = await assembleRevision({
        signer: invented,
        author: invented.userId,
        revisionId,
        parent: r2,
        authoredAtMs: Number(r2.authoredAtMs) + 1,
        lanes: [relabelled],
      });
      await expect(
        verifySyncPage(
          pageOf([r1, r2, r3]),
          [entryFor(provider), entryFor(invented)],
          { ...fromGenesis, actorUserId: provider.userId },
        ),
      ).rejects.toBeInstanceOf(ProtocolVerificationError);
    }
  });

  test("an incremental page may not reuse a Revision id the Device verified earlier", async () => {
    const { provider, invented, key, r1, r2 } = await rotation(1);
    const lane = new Map(parseProtocolObject(valueLaneOf(r1, 3)));
    lane.set(27, uuidToBytes(invented.userId));
    // R3 reuses R1's id, so the lane's field 16 names the Revision carrying
    // it; only the history before the starting point shows the repeat.
    const r3 = await assembleRevision({
      signer: invented,
      author: invented.userId,
      revisionId: r1.id,
      parent: r2,
      authoredAtMs: Number(r2.authoredAtMs) + 1,
      lanes: [await signFields(13, lane, invented.signing.privateKey)],
    });
    const fromHead: SyncPageWire = {
      ...pageOf([r3]),
      trustedRevisionId: r2.id,
      trustedRevisionHash: r2.digest,
    };
    const fromR2 = {
      expectedTrustedRevisionId: r2.id,
      expectedTrustedRevisionHash: r2.digest,
      actorUserId: provider.userId,
      trustedRevisionAuthoredAtMs: r2.authoredAtMs,
      trustedRevisionProjectEpoch: r2.projectEpoch,
    } as const;
    await expect(
      verifySyncPage(fromHead, [entryFor(provider), entryFor(invented)], {
        ...fromR2,
        knownRevisionIds: [r1.id, r2.id],
      }),
    ).rejects.toThrow("repeats a Revision id");
    // Without its history the Device cannot see the repeat, but it still
    // never applies the invented User's legacy lane.
    await verifySyncPage(
      fromHead,
      [entryFor(provider), entryFor(invented)],
      fromR2,
    );
    const previous = await decodeSyncVariables(
      pageOf([r1, r2]),
      () => provider.encryption.privateKey,
      [],
      key,
      provider.userId,
    );
    await expect(
      decodeSyncVariables(
        fromHead,
        () => provider.encryption.privateKey,
        previous,
        key,
        provider.userId,
      ),
    ).rejects.toBeInstanceOf(UnreadableLaneError);
  });

  test("a lane or descriptor naming another Team or Project is refused", async () => {
    const { provider, key } = await rotation(2);
    const published = await publish(provider, [password("value")], {
      parent: genesis,
      sharedValueSecret: key,
    });
    for (const field of [8, 11, 13] as const) {
      const moved = await resignRevision(
        published.artifacts.stagedObjects,
        published.artifacts.request.revision.protocolObjectId,
        published.artifacts.request.revision.id,
        genesis,
        provider.signing.privateKey,
        (lane) => new Map([...lane, [field, uuidToBytes(crypto.randomUUID())]]),
      );
      await expect(
        verifySyncPage(pageOf([moved]), [entryFor(provider)], fromGenesis),
      ).rejects.toThrow("not bound to the Revision");
    }
  });

  test("a Revision of another Team or Project is refused when the context is given", async () => {
    const { provider, r1 } = await rotation(2);
    const page = pageOf([r1]);
    await verifySyncPage(page, [entryFor(provider)], {
      ...fromGenesis,
      expectedContext: ids,
    });
    for (const expectedContext of [
      { ...ids, teamId: crypto.randomUUID() },
      { ...ids, projectId: crypto.randomUUID() },
      { ...ids, serverProfileId: crypto.randomUUID() },
    ])
      await expect(
        verifySyncPage(page, [entryFor(provider)], {
          ...fromGenesis,
          expectedContext,
        }),
      ).rejects.toThrow("another Server Profile, Team or Project");
  });
});

describe("ADR 0023: legacy lanes cannot cross Environment or Team boundaries", () => {
  const flagId = "99999999-9999-4999-8999-9999999999c1";
  const devEnvironmentId = "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae";
  const devGenesis = { id: devEnvironmentId, digest: new Uint8Array(48) };

  // Development's legacy Revision sets AUTH_DISABLED=true; the invented User
  // re-wraps those lanes into a Revision of production: same Project, same
  // key, and the format-1 associated data binds no Environment.
  const moved = async () => {
    const owner = await actor(userA, deviceA);
    const invented = await actor(userU, deviceU);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const source = await resealRevision(
      await publish(
        owner,
        [variable({ id: flagId, name: "AUTH_DISABLED", value: "true" })],
        {
          parent: devGenesis,
          sharedValueSecret: key,
          environmentId: devEnvironmentId,
        },
      ),
      owner,
      key,
      devEnvironmentId,
    );
    const lanes = await Promise.all(
      source.objects
        .filter(
          (object) => parseProtocolObject(object.canonicalBytes).get(1) === 13,
        )
        .map(async (object) => {
          const lane = new Map(parseProtocolObject(object.canonicalBytes));
          lane.set(14, uuidToBytes(ids.environmentId));
          if (lane.get(36) === 3) lane.set(27, uuidToBytes(invented.userId));
          return signFields(13, lane, invented.signing.privateKey);
        }),
    );
    const injected = await assembleRevision({
      signer: invented,
      author: invented.userId,
      // The format-1 ciphertext opens only under its original Revision id,
      // which no Revision of the production history has used.
      revisionId: source.id,
      parent: genesis,
      authoredAtMs: Number(source.authoredAtMs) + 1,
      lanes,
    });
    return { owner, invented, key, page: pageOf([injected]) };
  };

  test("the moved legacy lanes verify, but a Device never applies them from an unconfirmed author", async () => {
    const { owner, invented, key, page } = await moved();
    await verifySyncPage(page, [entryFor(owner), entryFor(invented)], {
      ...fromGenesis,
      actorUserId: owner.userId,
    });
    const decode = (legacyLaneAuthors: readonly string[]) =>
      decodeSyncManifest(
        page,
        () => owner.encryption.privateKey,
        [],
        key,
        owner.userId,
        owner.userValueKey,
        { legacyLaneAuthors },
      );
    const refusal = await decode([]).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(UnreadableLaneError);
    expect(refusal).toMatchObject({
      reason: "unconfirmed-legacy-author",
      authorUserId: invented.userId,
    });
    // A teammate the user confirmed is trusted with legacy lanes: they hold
    // the Project key and could publish the same Value anyway.
    const confirmed = await decode([invented.userId]);
    expect(
      confirmed.variables.find((entry) => entry.id === flagId)?.value,
    ).toBe("true");
  });

  test("an own or confirmed legacy history still reads, and a later format-2 Revision replaces an unconfirmed one", async () => {
    const owner = await actor(userA, deviceA);
    const teammate = await actor(userC, deviceC);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const r1 = await resealRevision(
      await publish(
        teammate,
        [variable({ id: flagId, name: "AUTH_DISABLED", value: "false" })],
        { parent: genesis, sharedValueSecret: key },
      ),
      teammate,
      key,
    );
    const page = pageOf([r1]);
    await verifySyncPage(page, [entryFor(owner), entryFor(teammate)], {
      ...fromGenesis,
      actorUserId: owner.userId,
    });
    const read = (
      viewer: Actor,
      target: SyncPageWire,
      legacyLaneAuthors: readonly string[],
    ) =>
      decodeSyncManifest(
        target,
        () => viewer.encryption.privateKey,
        [],
        key,
        viewer.userId,
        viewer.userValueKey,
        { legacyLaneAuthors },
      );
    // The author reads its own legacy lanes; a confirming viewer reads them.
    expect((await read(teammate, page, [])).variables[0]?.value).toBe("false");
    expect(
      (await read(owner, page, [teammate.userId])).variables[0]?.value,
    ).toBe("false");
    await expect(read(owner, page, [])).rejects.toBeInstanceOf(
      UnreadableLaneError,
    );
    // Once a key holder publishes the Variable again (format 2), the head no
    // longer depends on the legacy lane.
    const r2 = await publish(
      owner,
      [variable({ id: flagId, name: "AUTH_DISABLED", value: "false" })],
      { parent: r1, sharedValueSecret: key },
    );
    const republished = pageOf([r1, r2.wire]);
    await verifySyncPage(republished, [entryFor(owner), entryFor(teammate)], {
      ...fromGenesis,
      actorUserId: owner.userId,
    });
    expect((await read(owner, republished, [])).variables[0]?.value).toBe(
      "false",
    );
  });

  test("a readable tombstone retires a legacy Value this Device would not apply", async () => {
    const owner = await actor(userA, deviceA);
    const teammate = await actor(userC, deviceC);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const r1 = await resealRevision(
      await publish(
        teammate,
        [variable({ id: flagId, name: "AUTH_DISABLED", value: "false" })],
        { parent: genesis, sharedValueSecret: key },
      ),
      teammate,
      key,
    );
    // The owner deletes the Variable in format 2; nothing about it is left
    // to read, so the unconfirmed legacy Value no longer blocks the page.
    const r2 = await publish(
      owner,
      [
        variable({
          id: flagId,
          name: "AUTH_DISABLED",
          value: null,
          required: false,
          tombstone: true,
        }),
      ],
      { parent: r1, sharedValueSecret: key },
    );
    const page = pageOf([r1, r2.wire]);
    await verifySyncPage(page, [entryFor(owner), entryFor(teammate)], {
      ...fromGenesis,
      actorUserId: owner.userId,
    });
    const decoded = await decodeSyncManifest(
      page,
      () => owner.encryption.privateKey,
      [],
      key,
      owner.userId,
      owner.userValueKey,
      { legacyLaneAuthors: [] },
    );
    expect(decoded.variables).toEqual([
      expect.objectContaining({ id: flagId, tombstone: true, value: null }),
    ]);
  });

  test("a legacy User-defined Value cannot be presented in another Team through a plain key", async () => {
    // A Team A legacy ciphertext placed in a Team B Revision whose signer
    // names another User as author: only an author-bound signer may carry a
    // legacy User-defined Value lane.
    const victim = await actor(userC, deviceC);
    const member = await actor(userA, deviceA);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const teamA = {
      teamId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
      projectId: "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2",
      environmentId: "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3",
    };
    const source = await resealRevision(
      await publish(
        victim,
        [
          variable({
            id: flagId,
            name: "TOKEN",
            ownership: "USER_DEFINED_VALUE",
            value: "team-a-secret",
          }),
        ],
        {
          parent: { id: teamA.environmentId, digest: new Uint8Array(48) },
          sharedValueSecret: key,
          ...teamA,
        },
      ),
      victim,
      key,
      teamA.environmentId,
    );
    const definition = source.objects.find(
      (object) => parseProtocolObject(object.canonicalBytes).get(36) === 2,
    );
    if (!definition) throw new Error("definition lane is missing");
    const sourceLanes = [definition.canonicalBytes, valueLaneOf(source, 4)];
    for (const bytes of sourceLanes)
      expect(parseProtocolObject(bytes).get(11)).toEqual(
        uuidToBytes(teamA.teamId),
      );
    // The Member signs the lanes into a Team B Revision. They always take
    // Team B's Environment; `relabel` decides whether they also claim Team
    // B's Team and Project or still name Team A's.
    const teamBRevision = async (relabel: boolean) =>
      assembleRevision({
        signer: member,
        author: victim.userId,
        revisionId: source.id,
        parent: genesis,
        authoredAtMs: Number(source.authoredAtMs) + 1,
        lanes: await Promise.all(
          sourceLanes.map((bytes) => {
            const lane = new Map(parseProtocolObject(bytes));
            lane.set(14, uuidToBytes(ids.environmentId));
            if (relabel) {
              lane.set(11, uuidToBytes(ids.teamId));
              lane.set(13, uuidToBytes(ids.projectId));
            }
            return signFields(13, lane, member.signing.privateKey);
          }),
        ),
      });
    const toVictim = {
      ...fromGenesis,
      actorUserId: victim.userId,
      expectedContext: ids,
    } as const;
    // Lanes that still name Team A's Team and Project fail the Revision
    // binding.
    await expect(
      verifySyncPage(
        pageOf([await teamBRevision(false)]),
        [member.signingPublicKey],
        toVictim,
      ),
    ).rejects.toThrow("not bound to the Revision");
    // Relabelled to Team B, the legacy ciphertext would still open: its
    // associated data binds no Team. The author binding refuses it.
    const relabelled = await teamBRevision(true);
    const valueLane = valueLaneOf(relabelled, 4);
    expect(parseProtocolObject(valueLane).get(11)).toEqual(
      uuidToBytes(ids.teamId),
    );
    expect(
      new TextDecoder().decode(
        await openLane(
          valueLane,
          victim.encryption.privateKey,
          victim.userValueKey,
        ),
      ),
    ).toBe("team-a-secret");
    await expect(
      verifySyncPage(pageOf([relabelled]), [member.signingPublicKey], toVictim),
    ).rejects.toThrow("needs a signer bound to its author");
    // Constrained trust binds the author to the Member's own User.
    await expect(
      verifySyncPage(pageOf([relabelled]), [entryFor(member)], toVictim),
    ).rejects.toThrow("not authorized");
  });
});

// Re-seals every lane of a published Revision in the legacy format (signed by
// the author again) and rebuilds the commitments, descriptor and Revision.
const resealRevision = async (
  published: Readonly<{
    readonly artifacts: Awaited<ReturnType<typeof createPublicationArtifacts>>;
    readonly wire: SyncRevisionWire;
  }>,
  author: Actor,
  key: Uint8Array,
  environmentId: string = ids.environmentId,
): Promise<SyncRevisionWire> => {
  const resealed = new Map<string, Uint8Array>();
  for (const object of published.artifacts.stagedObjects) {
    const parsed = parseProtocolObject(object.bytes);
    if (parsed.get(1) !== 13) continue;
    resealed.set(
      object.objectId,
      await toLegacyLane(
        object.bytes,
        author,
        parsed.get(36) === 4 ? author.userValueKey : key,
        author.signing.privateKey,
      ),
    );
  }
  const lanes = published.artifacts.stagedObjects
    .filter((object) => resealed.has(object.objectId))
    .map((object) => resealed.get(object.objectId) as Uint8Array);
  return assembleRevision({
    signer: author,
    author: author.userId,
    revisionId: published.wire.id,
    parent: {
      id: published.wire.parentId ?? environmentId,
      digest: published.wire.parentHash ?? new Uint8Array(48),
    },
    authoredAtMs: Number(published.wire.authoredAtMs),
    lanes,
    environmentId,
  });
};
