import { describe, expect, test } from "bun:test";
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
    const parsed = parseEpochRotationRequest({
      projectId: "00000000-0000-4000-8000-000000000031",
      expectedEpoch: 1,
      newEpoch: 2,
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
    });
    expect(parsed.newEpoch).toBe(2);
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
