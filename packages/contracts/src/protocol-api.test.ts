import { describe, expect, test } from "bun:test";
import {
  decodeSyncPage,
  encodeSyncPage,
  formatSyncCursor,
  parseEpochRotationRequest,
  parseFinalizePublicationRequest,
  parseSha384Hex,
  parseSyncCursorValue,
  parseSyncRequest,
  parseUuid,
  sha384ToHex,
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
});
