import { describe, expect, test } from "bun:test";
import {
  reconcilePublicationBaseline,
  withResolvedConflicts,
} from "./baseline";
import type { DecodedVariable } from "./publication";

// Regression cases for a teammate's deletion meeting a stale draft. The
// draft carries the baseline's id for every name the baseline knew, which
// is how the CLI builds it from a dotenv file.

const variable = (
  id: string,
  name: string,
  value: string | null,
  overrides: Partial<DecodedVariable> = {},
): DecodedVariable =>
  Object.freeze({
    id,
    name,
    description: "",
    ownership: "SHARED_VALUE",
    value,
    required: true,
    tombstone: false,
    ...overrides,
  });

const tombstone = (id: string, name: string): DecodedVariable =>
  variable(id, name, null, { tombstone: true });

const changed = (result: ReturnType<typeof reconcilePublicationBaseline>) =>
  result.merged.filter((entry) => entry.hasDraftChange);

const liveNames = (variables: readonly DecodedVariable[]) =>
  variables.filter((entry) => !entry.tombstone).map((entry) => entry.name);

describe("baseline reconciliation against a remote deletion", () => {
  test("an unchanged local row lets the teammate's deletion stand", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a1", "A", "1")],
      draft: [variable("a1", "A", "1")],
      remote: [tombstone("a1", "A")],
      remoteChangedVariableIds: new Set(["a1"]),
    });
    expect(result.conflicts).toHaveLength(0);
    expect(changed(result)).toHaveLength(0);
    expect(liveNames(result.merged)).toEqual([]);
  });

  test("a locally edited row the teammate deleted is a deletion conflict", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a1", "A", "1")],
      draft: [variable("a1", "A", "2")],
      remote: [tombstone("a1", "A")],
      remoteChangedVariableIds: new Set(["a1"]),
    });
    expect(changed(result)).toHaveLength(0);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ key: "a1", name: "A", kinds: ["deletion"] }),
    ]);
    const keepRemote = withResolvedConflicts(
      result,
      new Map([["a1", "remote"]]),
    );
    expect(keepRemote.filter((entry) => entry.hasDraftChange)).toHaveLength(0);
    const keepLocal = withResolvedConflicts(result, new Map([["a1", "local"]]));
    expect(keepLocal).toEqual([
      expect.objectContaining({
        id: "a1",
        value: "2",
        tombstone: false,
        hasDraftChange: true,
      }),
    ]);
  });

  test("an unchanged local row does not overwrite a re-added Variable", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a1", "A", "old")],
      draft: [variable("a1", "A", "old")],
      remote: [tombstone("a1", "A"), variable("a2", "A", "new")],
      remoteChangedVariableIds: new Set(["a1", "a2"]),
    });
    expect(result.conflicts).toHaveLength(0);
    expect(changed(result)).toHaveLength(0);
    expect(result.merged.filter((entry) => !entry.tombstone)).toEqual([
      expect.objectContaining({ id: "a2", value: "new" }),
    ]);
  });

  test("a local edit meeting a re-added Variable is a name conflict", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a1", "A", "old")],
      draft: [variable("a1", "A", "mine")],
      remote: [tombstone("a1", "A"), variable("a2", "A", "new")],
      remoteChangedVariableIds: new Set(["a1", "a2"]),
    });
    expect(changed(result)).toHaveLength(0);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        key: "name:A",
        kinds: ["name"],
        choices: ["local", "remote"],
        local: expect.objectContaining({ id: "a1", value: "mine" }),
        remote: expect.objectContaining({ id: "a2", value: "new" }),
      }),
    ]);
    const keepRemote = withResolvedConflicts(
      result,
      new Map([["name:A", "remote"]]),
    );
    expect(keepRemote.filter((entry) => entry.hasDraftChange)).toHaveLength(0);
    expect(liveNames(keepRemote)).toEqual(["A"]);
    const keepLocal = withResolvedConflicts(
      result,
      new Map([["name:A", "local"]]),
    );
    // One live A, and no id appears twice.
    expect(liveNames(keepLocal)).toEqual(["A"]);
    expect(new Set(keepLocal.map((entry) => entry.id)).size).toBe(
      keepLocal.length,
    );
    expect(keepLocal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a1", value: "mine", tombstone: false }),
        expect.objectContaining({ id: "a2", tombstone: true }),
      ]),
    );
  });

  test("a local edit that matches the re-added Variable converges", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a1", "A", "old")],
      draft: [variable("a1", "A", "new")],
      remote: [tombstone("a1", "A"), variable("a2", "A", "new")],
      remoteChangedVariableIds: new Set(["a1", "a2"]),
    });
    expect(result.conflicts).toHaveLength(0);
    expect(changed(result)).toHaveLength(0);
    expect(liveNames(result.merged)).toEqual(["A"]);
  });

  test("a local deletion beside a re-added Variable keeps the teammate's", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a1", "A", "old")],
      draft: [],
      remote: [tombstone("a1", "A"), variable("a2", "A", "new")],
      remoteChangedVariableIds: new Set(["a1", "a2"]),
    });
    expect(result.conflicts).toHaveLength(0);
    expect(changed(result)).toHaveLength(0);
    expect(liveNames(result.merged)).toEqual(["A"]);
  });
});
