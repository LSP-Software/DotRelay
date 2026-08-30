import { describe, expect, test } from "bun:test";
import {
  encodeSyncPage,
  formatSyncCursor,
  parseFinalizePublicationRequest,
  parseSha384Hex,
  parseSyncCursorValue,
  parseSyncRequest,
  parseUuid,
  sha384ToHex,
} from "@dotrelay/contracts";

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
});
