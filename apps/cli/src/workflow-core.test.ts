import { describe, expect, test } from "bun:test";
import type { RevisionSigningTrustEntry } from "@dotrelay/client";
import {
  authoredAtFloor,
  collectSigningTrust,
  headAuthoredAtMs,
  parseBoundary,
  rotationOwedNotice,
} from "./workflow-core";

const deviceId = "33333333-3333-4333-8333-333333333333";
const otherDeviceId = "88888888-8888-4888-8888-888888888888";
const userId = "22222222-2222-4222-8222-222222222222";
const ownKey = "11".repeat(32);
const otherKey = "22".repeat(32);

const boundaryWith = (
  environment: Record<string, unknown> = {},
  signingTrustDevices: unknown[] = [],
) =>
  parseBoundary({
    session: { active: true, userId },
    environment: {
      id: "66666666-6666-4666-8666-666666666666",
      projectId: "55555555-5555-4555-8555-555555555555",
      teamId: "44444444-4444-4444-8444-444444444444",
      headRevision: "empty-environment",
      headHash: null,
      projectEpoch: "1",
      ...environment,
    },
    device: { active: true, id: deviceId },
    signingTrustDevices,
  });

const trustEntry = (overrides: Record<string, unknown> = {}) => ({
  deviceId,
  userId,
  signingPublicKey: ownKey,
  deviceActiveFromMs: 1_000,
  deviceActiveUntilMs: null,
  memberSinceMs: 5_000,
  memberUntilMs: null,
  ...overrides,
});

describe("boundary Membership periods (ADR 0017)", () => {
  test("parses membershipPeriods and forwards them into the trust entries", () => {
    const periods = [
      { sinceMs: 100, untilMs: 200 },
      { sinceMs: 5_000, untilMs: null },
    ];
    const boundary = boundaryWith({}, [
      trustEntry({ membershipPeriods: periods }),
    ]);
    expect(boundary.signingTrustDevices[0]?.membershipPeriods).toEqual(periods);
    const trust = collectSigningTrust(
      boundary,
      new Uint8Array(32).fill(0x33),
    ) as readonly RevisionSigningTrustEntry[];
    expect(trust[0]?.membershipPeriods).toEqual(periods);
    expect(trust[0]?.memberSinceMs).toBe(5_000);
  });

  test("ignores a malformed period list and keeps the current window", () => {
    const boundary = boundaryWith({}, [
      trustEntry({ membershipPeriods: [{ sinceMs: "100", untilMs: null }] }),
    ]);
    const [entry] = boundary.signingTrustDevices;
    expect(entry).toBeDefined();
    expect(entry?.membershipPeriods).toBeUndefined();
    expect(entry?.memberSinceMs).toBe(5_000);
  });

  test("keeps every distinct entry for one key instead of the first only", () => {
    const boundary = boundaryWith({}, [
      trustEntry({ membershipPeriods: [{ sinceMs: 5_000, untilMs: null }] }),
      trustEntry({
        membershipPeriods: [
          { sinceMs: 100, untilMs: 200 },
          { sinceMs: 5_000, untilMs: null },
        ],
      }),
      trustEntry({ membershipPeriods: [{ sinceMs: 5_000, untilMs: null }] }),
    ]);
    const local = new Uint8Array(32).fill(0x11);
    const trust = collectSigningTrust(
      boundary,
      local,
    ) as readonly RevisionSigningTrustEntry[];
    // Exact duplicates collapse; the local key already has an entry, so no
    // unconstrained fallback is added for it.
    expect(trust).toHaveLength(2);
    expect(trust.map((entry) => entry.membershipPeriods?.length)).toEqual([
      1, 2,
    ]);
  });
});

describe("authored-at floor", () => {
  test("is the latest of Device activation, Membership activation, and the parent", () => {
    const boundary = boundaryWith({}, [
      trustEntry({ signingPublicKey: otherKey, deviceId: otherDeviceId }),
      trustEntry({ deviceActiveFromMs: 1_000, memberSinceMs: 5_000 }),
    ]);
    expect(authoredAtFloor(boundary, deviceId)).toBe(5_000);
    expect(authoredAtFloor(boundary, deviceId.toUpperCase())).toBe(5_000);
    expect(authoredAtFloor(boundary, deviceId, 9_000n)).toBe(9_000);
    expect(authoredAtFloor(boundary, deviceId, 2_000n)).toBe(5_000);
  });

  test("falls back to the parent alone without a trust entry for this Device", () => {
    const boundary = boundaryWith();
    expect(authoredAtFloor(boundary, deviceId)).toBeUndefined();
    expect(authoredAtFloor(boundary, deviceId, 7_000n)).toBe(7_000);
  });

  test("reads the head Revision's authored-at instant from a synced page", () => {
    const revisions = [
      { id: "a", authoredAtMs: 10n },
      { id: "b", authoredAtMs: 20n },
    ];
    expect(headAuthoredAtMs({ currentHeadId: null, revisions: [] })).toBe(null);
    expect(headAuthoredAtMs({ currentHeadId: "a", revisions })).toBe(10n);
    // A page cut short by --limit ends before the head: its last Revision
    // still bounds the head from below.
    expect(headAuthoredAtMs({ currentHeadId: "z", revisions })).toBe(20n);
  });
});

describe("owed Project key rotation", () => {
  const owed = {
    since: "2026-11-01T09:30:00.000Z",
    sinceEpoch: "3",
    membershipRemovals: 2,
    deviceRevocations: 0,
  };

  test("parses rotationOwed from the boundary Environment", () => {
    expect(boundaryWith().environment.rotationOwed).toBeNull();
    expect(
      boundaryWith({ rotationOwed: null }).environment.rotationOwed,
    ).toBeNull();
    expect(
      boundaryWith({ rotationOwed: owed }).environment.rotationOwed,
    ).toEqual(owed);
  });

  test("drops a malformed obligation instead of failing the workflow", () => {
    for (const rotationOwed of [
      { ...owed, since: "yesterday" },
      { ...owed, sinceEpoch: 3 },
      { ...owed, membershipRemovals: -1 },
      { ...owed, deviceRevocations: "1" },
      "owed",
    ])
      expect(
        boundaryWith({ rotationOwed }).environment.rotationOwed,
      ).toBeNull();
  });

  test("tells owners and admins what to rotate and what to change", () => {
    expect(rotationOwedNotice(owed)).toBe(
      "2 Members removed since 2026-11-01. A Team owner or admin should rotate this Project's key with dotrelay project rotate, then change the secrets they could read.",
    );
    expect(
      rotationOwedNotice({
        ...owed,
        membershipRemovals: 0,
        deviceRevocations: 1,
      }),
    ).toStartWith("1 Device revoked since 2026-11-01.");
  });
});
