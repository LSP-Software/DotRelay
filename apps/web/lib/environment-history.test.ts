import { expect, test } from "bun:test";
import {
  authorInitials,
  formatDayLabel,
  formatPublishSummary,
  formatRelativeTime,
  groupHistoryByDay,
  historyEntriesFromSync,
  mergeHistoryEntries,
  nextHistoryVisibleCount,
  previewHistoryEntries,
  summarizeManifestChange,
} from "./environment-history";

const variable = (
  id: string,
  name: string,
  value: string | null,
  extra?: Readonly<{ tombstone?: boolean; description?: string }>,
) => ({
  id,
  name,
  description: extra?.description ?? "",
  value,
  ...(extra?.tombstone === undefined ? {} : { tombstone: extra.tombstone }),
});

test("summarizeManifestChange counts added, changed, and removed Variables", () => {
  const previous = [
    variable("1", "API_ORIGIN", "old"),
    variable("2", "SIGNING_KEY", "keep"),
    variable("3", "OLD_TOKEN", "gone"),
  ];
  const next = [
    variable("1", "API_ORIGIN", "new"),
    variable("2", "SIGNING_KEY", "keep"),
    variable("3", "OLD_TOKEN", null, { tombstone: true }),
    variable("4", "FEATURE_GATE", "on"),
  ];

  expect(summarizeManifestChange(previous, next)).toEqual({
    added: 1,
    changed: 1,
    removed: 1,
    addedNames: ["FEATURE_GATE"],
    changedNames: ["API_ORIGIN"],
    removedNames: ["OLD_TOKEN"],
  });
});

test("summarizeManifestChange treats a restored tombstone as added", () => {
  expect(
    summarizeManifestChange(
      [variable("1", "FEATURE_GATE", null, { tombstone: true })],
      [variable("1", "FEATURE_GATE", "on")],
    ),
  ).toMatchObject({ added: 1, addedNames: ["FEATURE_GATE"], changed: 0 });
});

test("formatPublishSummary names a short delta and counts a long one", () => {
  expect(
    formatPublishSummary({
      kind: "update",
      added: 1,
      changed: 1,
      removed: 0,
      addedNames: ["FEATURE_GATE"],
      changedNames: ["API_ORIGIN"],
      removedNames: [],
    }),
  ).toBe("Added FEATURE_GATE, changed API_ORIGIN");

  expect(
    formatPublishSummary({
      kind: "update",
      added: 0,
      changed: 12,
      removed: 0,
      addedNames: [],
      changedNames: Array.from({ length: 12 }, (_, index) => `VAR_${index}`),
      removedNames: [],
    }),
  ).toBe("12 variables changed");

  expect(
    formatPublishSummary({
      kind: "update",
      added: 2,
      changed: 3,
      removed: 1,
      addedNames: ["A", "B"],
      changedNames: ["C", "D", "E"],
      removedNames: ["F"],
    }),
  ).toBe("2 added, 3 changed, 1 removed");
});

test("formatPublishSummary describes the first publish without a Revision id", () => {
  expect(
    formatPublishSummary({
      kind: "genesis",
      added: 2,
      changed: 0,
      removed: 0,
      addedNames: ["API_ORIGIN", "SIGNING_KEY"],
      changedNames: [],
      removedNames: [],
    }),
  ).toBe("Started with API_ORIGIN and SIGNING_KEY");
});

test("nextHistoryVisibleCount pages without passing the total", () => {
  expect(nextHistoryVisibleCount(25, 80)).toBe(50);
  expect(nextHistoryVisibleCount(75, 80)).toBe(80);
});

test("mergeHistoryEntries keeps current when a sync page is empty", () => {
  const current = previewHistoryEntries("Ari Stone", 1_000);
  expect(mergeHistoryEntries(current, [])).toBe(current);
});

test("mergeHistoryEntries adds unseen revisions without duplicating", () => {
  const current = previewHistoryEntries("Ari Stone", 10_000);
  const latest = current[0];
  if (!latest) throw new Error("preview history is empty");
  const incoming = [
    Object.freeze({
      ...latest,
      revisionId: "rev_0185",
      authoredAtMs: 10_000,
    }),
    latest,
  ];
  expect(
    mergeHistoryEntries(current, incoming).map((entry) => entry.revisionId),
  ).toEqual(["rev_0185", "rev_0184", "rev_0183", "rev_0182"]);
});

test("formatRelativeTime and day labels stay calendar-aware", () => {
  const now = Date.parse("2026-09-06T17:00:00+01:00");
  expect(formatRelativeTime(now - 12_000, now)).toBe("just now");
  expect(formatRelativeTime(now - 12 * 60 * 1000, now)).toBe("12m ago");
  expect(formatRelativeTime(now - 3 * 60 * 60 * 1000, now)).toBe("3h ago");
  expect(formatRelativeTime(now - 26 * 60 * 60 * 1000, now)).toBe("yesterday");
  expect(formatDayLabel(now, now)).toBe("Today");
  expect(formatDayLabel(now - 26 * 60 * 60 * 1000, now)).toBe("Yesterday");
});

test("groupHistoryByDay keeps newest-first order inside each day", () => {
  const now = Date.parse("2026-09-06T17:00:00+01:00");
  const entries = previewHistoryEntries("Ari Stone", now);
  const groups = groupHistoryByDay(entries, now);
  expect(groups.map((group) => group.label)).toEqual([
    "Today",
    "Yesterday",
    "31 Aug",
  ]);
  expect(groups[0]?.entries[0]?.revisionId).toBe("rev_0184");
  expect(groups[0]?.entries[0]?.authorLabel).toBe("Ari Stone");
});

test("historyEntriesFromSync walks snapshots oldest to newest then displays newest first", () => {
  const first = [variable("1", "API_ORIGIN", "a")];
  const second = [
    variable("1", "API_ORIGIN", "b"),
    variable("2", "FEATURE_GATE", "on"),
  ];
  const entries = historyEntriesFromSync({
    revisions: [
      {
        id: "rev_old",
        digest: new Uint8Array(48),
        parentId: null,
        parentHash: null,
        mutation: 1,
        projectEpoch: 1n,
        authoredAtMs: 1_000n,
        rollbackTargetId: null,
        objects: [],
      },
      {
        id: "rev_new",
        digest: new Uint8Array(48),
        parentId: "rev_old",
        parentHash: new Uint8Array(48),
        mutation: 2,
        projectEpoch: 1n,
        authoredAtMs: 2_000n,
        rollbackTargetId: null,
        objects: [],
      },
    ],
    snapshots: new Map([
      ["rev_old", first],
      ["rev_new", second],
    ]),
  });

  expect(entries.map((entry) => entry.revisionId)).toEqual([
    "rev_new",
    "rev_old",
  ]);
  expect(entries[0]).toMatchObject({
    kind: "update",
    added: 1,
    changed: 1,
    authorLabel: "A Member",
  });
  expect(entries[1]).toMatchObject({
    kind: "genesis",
    added: 1,
    authorLabel: "A Member",
  });
});

test("authorInitials uses the first and last name", () => {
  expect(authorInitials("Ari Stone")).toBe("AS");
  expect(authorInitials("Maya")).toBe("MA");
});
