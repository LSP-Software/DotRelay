import { describe, expect, test } from "bun:test";
import {
  CBOR_LIMITS,
  type CborValue,
  canonicalDecode,
  canonicalEncode,
} from "./cbor";
import { ContractError } from "./errors";
import {
  bytesToUuid,
  decodeSyncPage,
  encodeSyncPage,
  formatSyncCursor,
  parseBeginOperationRequest,
  parseEpochRotationRequest,
  parseFinalizePublicationRequest,
  parseSha384Hex,
  parseSyncCursorValue,
  parseSyncRequest,
  parseUuid,
  sha384ToHex,
  uuidToBytes,
} from "./protocol-api";

describe("protocol API contracts", () => {
  test("parses sync requests and cursor values", () => {
    const digest = new Uint8Array(48).fill(0xab);
    const revisionId = "00000000-0000-4000-8000-000000000001";
    expect(
      parseSyncRequest({
        trustedRevisionId: revisionId,
        trustedRevisionHash: sha384ToHex(digest),
      }),
    ).toMatchObject({
      trustedRevisionId: revisionId,
      pagination: {},
    });
    const cursor = formatSyncCursor(revisionId, digest);
    expect(parseSyncCursorValue(cursor)).toMatchObject({
      revisionId,
    });
    expect(parseUuid(revisionId, "id")).toBe(revisionId);
    expect(parseSha384Hex(sha384ToHex(digest), "digest")).toEqual(digest);
  });

  test("encodes a bounded synchronization page", () => {
    const digest = new Uint8Array(48).fill(0x01);
    const page = encodeSyncPage({
      environmentId: "00000000-0000-4000-8000-000000000002",
      trustedRevisionId: "00000000-0000-4000-8000-000000000001",
      trustedRevisionHash: digest,
      currentHeadId: "00000000-0000-4000-8000-000000000003",
      currentHeadHash: digest,
      projectEpoch: 1n,
      revisions: [],
      nextCursor: null,
    });
    expect(page.length).toBeGreaterThan(0);
  });

  test("parses finalize publication requests with strict JSON", () => {
    const digest = sha384ToHex(new Uint8Array(48).fill(0x02));
    const parsed = parseFinalizePublicationRequest({
      environmentId: "00000000-0000-4000-8000-000000000010",
      expectedHeadId: null,
      revision: {
        id: "00000000-0000-4000-8000-000000000011",
        protocolObjectId: "00000000-0000-4000-8000-000000000012",
        projectEpoch: 1,
        mutation: "GENESIS",
        authoredAtMs: 1,
      },
      descriptor: {
        protocolObjectId: "00000000-0000-4000-8000-000000000013",
        schemaVersion: 1,
        descriptorHash: digest,
        laneCount: 0,
      },
      lanes: [],
      commitments: [],
    });
    expect(parsed.revision.mutation).toBe("GENESIS");
    expect(parsed.descriptor.laneCount).toBe(0);
  });

  test("rejects unsafe, negative and oversized publication numbers", () => {
    const valid = {
      environmentId: "00000000-0000-4000-8000-000000000010",
      expectedHeadId: null,
      revision: {
        id: "00000000-0000-4000-8000-000000000011",
        protocolObjectId: "00000000-0000-4000-8000-000000000012",
        projectEpoch: 1,
        mutation: "GENESIS",
        authoredAtMs: 1,
      },
      descriptor: {
        protocolObjectId: "00000000-0000-4000-8000-000000000013",
        schemaVersion: 1,
        descriptorHash: sha384ToHex(new Uint8Array(48).fill(0x02)),
        laneCount: 0,
      },
      lanes: [],
      commitments: [],
    };
    expect(() => parseFinalizePublicationRequest(valid)).not.toThrow();
    for (const revision of [
      { projectEpoch: 2 ** 53 },
      { authoredAtMs: Number.MAX_SAFE_INTEGER + 2 },
    ])
      expect(() =>
        parseFinalizePublicationRequest({
          ...valid,
          revision: { ...valid.revision, ...revision },
        }),
      ).toThrow(ContractError);
    for (const descriptor of [
      { laneCount: CBOR_LIMITS.maxManifestLaneCommitments + 1 },
      { laneCount: -1 },
      { laneCount: 2 ** 60 },
      { schemaVersion: 0 },
    ])
      expect(() =>
        parseFinalizePublicationRequest({
          ...valid,
          descriptor: { ...valid.descriptor, ...descriptor },
        }),
      ).toThrow(ContractError);
    const commitment = {
      ordinal: 0,
      laneObjectId: "00000000-0000-4000-8000-000000000014",
      objectHash: sha384ToHex(new Uint8Array(48).fill(0x03)),
      projectEpoch: 1,
      scope: "ENVIRONMENT_DEFINITION",
      ciphertextLength: 16,
    };
    expect(() =>
      parseFinalizePublicationRequest({ ...valid, commitments: [commitment] }),
    ).not.toThrow();
    for (const change of [
      { ciphertextLength: CBOR_LIMITS.maxObjectBytes + 1 },
      { ordinal: CBOR_LIMITS.maxManifestLaneCommitments },
      { ordinal: 1.5 },
    ])
      expect(() =>
        parseFinalizePublicationRequest({
          ...valid,
          commitments: [{ ...commitment, ...change }],
        }),
      ).toThrow(ContractError);
    expect(() =>
      parseEpochRotationRequest({
        projectId: "00000000-0000-4000-8000-000000000015",
        expectedEpoch: 2 ** 53,
        newEpoch: 2 ** 53 + 2,
        transitions: [],
      }),
    ).toThrow(ContractError);
  });

  test("decodeSyncPage enforces page and cursor limits", () => {
    const digest = new Uint8Array(48).fill(0x04);
    const base = {
      environmentId: "00000000-0000-4000-8000-000000000030",
      trustedRevisionId: "00000000-0000-4000-8000-000000000031",
      trustedRevisionHash: digest,
      currentHeadId: null,
      currentHeadHash: null,
      projectEpoch: 1n,
      revisions: [
        {
          id: "00000000-0000-4000-8000-000000000032",
          digest,
          parentId: null,
          parentHash: null,
          mutation: 1,
          projectEpoch: 1n,
          authoredAtMs: 1n,
          rollbackTargetId: null,
          objects: [],
        },
      ],
      nextCursor: null,
    } as const;
    expect(() =>
      decodeSyncPage(encodeSyncPage({ ...base, nextCursor: "c".repeat(1025) })),
    ).toThrow(ContractError);
    const envelope = canonicalDecode(encodeSyncPage(base)) as Map<
      number,
      CborValue
    >;
    const [revisionsKey, revisions] = [...envelope].find(([, value]) =>
      Array.isArray(value),
    ) as [number, CborValue[]];
    const oversized = new Map(envelope);
    oversized.set(
      revisionsKey,
      Array.from(
        { length: CBOR_LIMITS.maxSyncObjects + 1 },
        () => revisions[0] as CborValue,
      ),
    );
    expect(() => decodeSyncPage(canonicalEncode(oversized))).toThrow(
      ContractError,
    );
  });

  test("round-trips synchronization pages through CBOR", () => {
    const digest = new Uint8Array(48).fill(0x03);
    const encoded = encodeSyncPage({
      environmentId: "00000000-0000-4000-8000-000000000020",
      trustedRevisionId: "00000000-0000-4000-8000-000000000021",
      trustedRevisionHash: digest,
      currentHeadId: "00000000-0000-4000-8000-000000000022",
      currentHeadHash: digest,
      projectEpoch: 2n,
      revisions: [],
      nextCursor: formatSyncCursor(
        "00000000-0000-4000-8000-000000000023",
        digest,
      ),
    });
    const decoded = decodeSyncPage(encoded);
    expect(decoded.environmentId).toBe("00000000-0000-4000-8000-000000000020");
    expect(decoded.projectEpoch).toBe(2n);
    expect(decoded.nextCursor).toBe(
      formatSyncCursor("00000000-0000-4000-8000-000000000023", digest),
    );
  });

  test("round-trips a revision with optional fields", () => {
    const digest = new Uint8Array(48).fill(0x05);
    const parentHash = new Uint8Array(48).fill(0x06);
    const objectBytes = new Uint8Array([0x01, 0x02, 0x03]);
    const objectDigest = new Uint8Array(48).fill(0x07);
    const decoded = decodeSyncPage(
      encodeSyncPage({
        environmentId: "00000000-0000-4000-8000-000000000040",
        trustedRevisionId: "00000000-0000-4000-8000-000000000041",
        trustedRevisionHash: digest,
        currentHeadId: null,
        currentHeadHash: null,
        projectEpoch: 3n,
        revisions: [
          {
            id: "00000000-0000-4000-8000-000000000042",
            digest,
            parentId: "00000000-0000-4000-8000-000000000041",
            parentHash,
            mutation: 1,
            projectEpoch: 3n,
            authoredAtMs: 9n,
            rollbackTargetId: "00000000-0000-4000-8000-000000000043",
            objects: [
              {
                objectId: "00000000-0000-4000-8000-000000000044",
                canonicalBytes: objectBytes,
                digest: objectDigest,
              },
            ],
          },
        ],
        nextCursor: null,
      }),
    );
    expect(decoded.revisions[0]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000042",
      parentId: "00000000-0000-4000-8000-000000000041",
      rollbackTargetId: "00000000-0000-4000-8000-000000000043",
    });
    expect(decoded.revisions[0]?.objects[0]?.canonicalBytes).toEqual(
      objectBytes,
    );
  });

  test("parses epoch rotation requests with embedded publications", () => {
    const digest = sha384ToHex(new Uint8Array(48).fill(0x04));
    const environmentId = "00000000-0000-4000-8000-000000000030";
    const request = {
      projectId: "00000000-0000-4000-8000-000000000031",
      expectedEpoch: 1,
      newEpoch: 2,
      keyLink: { protocolObjectId: "00000000-0000-4000-8000-000000000037" },
      transitions: [
        {
          environmentId,
          expectedHeadId: "00000000-0000-4000-8000-000000000032",
          newHeadId: "00000000-0000-4000-8000-000000000033",
          protocolObjectId: "00000000-0000-4000-8000-000000000034",
          publication: {
            environmentId,
            expectedHeadId: "00000000-0000-4000-8000-000000000032",
            revision: {
              id: "00000000-0000-4000-8000-000000000035",
              protocolObjectId: "00000000-0000-4000-8000-000000000034",
              projectEpoch: 2,
              mutation: "EPOCH_TRANSITION",
              authoredAtMs: 1,
            },
            descriptor: {
              protocolObjectId: "00000000-0000-4000-8000-000000000036",
              schemaVersion: 1,
              descriptorHash: digest,
              laneCount: 0,
            },
            lanes: [],
            commitments: [],
          },
        },
      ],
    };
    const parsed = parseEpochRotationRequest(request);
    expect(parsed.newEpoch).toBe(2);
    expect(parsed.keyLink.protocolObjectId).toBe(
      "00000000-0000-4000-8000-000000000037",
    );
    // A rotation without exactly one key link (ADR 0014) is malformed.
    const { keyLink: _keyLink, ...withoutLink } = request;
    expect(() => parseEpochRotationRequest(withoutLink)).toThrow(ContractError);
    expect(() =>
      parseEpochRotationRequest({
        ...request,
        keyLink: [request.keyLink, request.keyLink],
      }),
    ).toThrow(ContractError);
    expect(() =>
      parseEpochRotationRequest({
        ...request,
        keyLink: { protocolObjectId: "not-a-uuid" },
      }),
    ).toThrow(ContractError);
    expect(parsed.transitions[0]?.publication.revision.mutation).toBe(
      "EPOCH_TRANSITION",
    );
  });

  test("rejects malformed protocol API inputs", () => {
    expect(() =>
      parseUuid("00000000-0000-0000-8000-000000000000", "id"),
    ).toThrow(ContractError);
    expect(() => parseSha384Hex("abc", "digest")).toThrow(ContractError);
    expect(() =>
      parseFinalizePublicationRequest({
        environmentId: "00000000-0000-4000-8000-000000000010",
        expectedHeadId: null,
        revision: {
          id: "00000000-0000-4000-8000-000000000011",
          protocolObjectId: "00000000-0000-4000-8000-000000000012",
          projectEpoch: -1,
          mutation: "GENESIS",
          authoredAtMs: 1,
        },
        descriptor: {
          protocolObjectId: "00000000-0000-4000-8000-000000000013",
          schemaVersion: 1,
          descriptorHash: sha384ToHex(new Uint8Array(48).fill(0x02)),
          laneCount: 0,
        },
        lanes: [],
        commitments: [],
      }),
    ).toThrow(ContractError);
    expect(() =>
      parseFinalizePublicationRequest({
        environmentId: "00000000-0000-4000-8000-000000000010",
        expectedHeadId: null,
        revision: {
          id: "00000000-0000-4000-8000-000000000011",
          protocolObjectId: "00000000-0000-4000-8000-000000000012",
          projectEpoch: 1,
          mutation: "NOT_A_MUTATION",
          authoredAtMs: 1,
        },
        descriptor: {
          protocolObjectId: "00000000-0000-4000-8000-000000000013",
          schemaVersion: 1,
          descriptorHash: sha384ToHex(new Uint8Array(48).fill(0x02)),
          laneCount: 0,
        },
        lanes: [],
        commitments: [],
      }),
    ).toThrow(ContractError);
    expect(() =>
      parseEpochRotationRequest({
        projectId: "00000000-0000-4000-8000-000000000031",
        expectedEpoch: 2,
        newEpoch: 2,
        transitions: [],
      }),
    ).toThrow(ContractError);
    expect(() =>
      parseEpochRotationRequest({
        projectId: "00000000-0000-4000-8000-000000000031",
        expectedEpoch: 1,
        newEpoch: 2,
        transitions: [
          {
            environmentId: "00000000-0000-4000-8000-000000000030",
            expectedHeadId: "00000000-0000-4000-8000-000000000032",
            newHeadId: "00000000-0000-4000-8000-000000000033",
            protocolObjectId: "00000000-0000-4000-8000-000000000034",
            publication: {
              environmentId: "00000000-0000-4000-8000-000000000099",
              expectedHeadId: "00000000-0000-4000-8000-000000000032",
              revision: {
                id: "00000000-0000-4000-8000-000000000035",
                protocolObjectId: "00000000-0000-4000-8000-000000000034",
                projectEpoch: 2,
                mutation: "EPOCH_TRANSITION",
                authoredAtMs: 1,
              },
              descriptor: {
                protocolObjectId: "00000000-0000-4000-8000-000000000036",
                schemaVersion: 1,
                descriptorHash: sha384ToHex(new Uint8Array(48).fill(0x04)),
                laneCount: 0,
              },
              lanes: [],
              commitments: [],
            },
          },
        ],
      }),
    ).toThrow(ContractError);
  });

  test("parses begin operation requests and uuid byte helpers", () => {
    const digest = sha384ToHex(new Uint8Array(48).fill(0x08));
    expect(
      parseBeginOperationRequest({
        operationId: "00000000-0000-4000-8000-000000000050",
        kind: "REVISION_PUBLICATION",
        commandDigest: digest,
        expiresAt: "2026-08-30T20:00:00.000Z",
      }),
    ).toMatchObject({
      kind: "REVISION_PUBLICATION",
      expiresAt: "2026-08-30T20:00:00.000Z",
    });
    expect(() =>
      parseBeginOperationRequest({
        operationId: "00000000-0000-4000-8000-000000000050",
        kind: "REVISION_PUBLICATION",
        commandDigest: digest,
        expiresAt: "not-an-iso-instant",
      }),
    ).toThrow(ContractError);
    const uuid = "00000000-0000-4000-8000-000000000051";
    expect(bytesToUuid(uuidToBytes(uuid))).toBe(uuid);
  });
});
