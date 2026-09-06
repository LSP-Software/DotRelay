import { expect, test } from "bun:test";
import {
  applyConflictResolution,
  applyRollbackToVariables,
  bareVerifiedRevision,
  canActorChangeDefinitions,
  canActorChangeVariableValue,
  changedLaneCount,
  createEnvironmentVariable,
  createRollbackPlan,
  deleteEnvironmentVariable,
  displayedSetupAction,
  draftValueDiffs,
  type EnvironmentVariable,
  loadRollbackHistory,
  locallyPublishedRevision,
  mergeDraftVariablesOverRemote,
  mergeVerifiedHistory,
  nextSetupAction,
  prepareEncryptedPublication,
  publicationMutationForHead,
  publishedBaseline,
  readOnlyReason,
  reconcileDraftWithPermissions,
  revisionMutationLabel,
  roleLabel,
  rollbackValueDiffs,
  settlePublishedDraft,
  seedEnvironmentVariables,
  splitInlineValueDiff,
  summarizeConflict,
  updateVariableValue,
  type VerifiedRevision,
  validateEnvironmentLabel,
  validateEnvironmentVariables,
  validateVariableDraft,
  variableHasDraftChange,
  verifiedRevisionFromWire,
} from "./environment-workflow";

const sharedDraft = {
  name: "API_ORIGIN",
  description: "The public API origin.",
  ownership: "SHARED_VALUE" as const,
  value: "",
  valuePresent: true,
  required: true,
};

test("new Variables require a valid name and explicit ownership", () => {
  expect(
    validateVariableDraft({ ...sharedDraft, name: "not valid" }),
  ).toContain("letters");
  expect(validateVariableDraft({ ...sharedDraft, ownership: "" })).toContain(
    "Choose who can read the value.",
  );
  expect(validateVariableDraft(sharedDraft)).toBeNull();
});

test("new Variables cannot duplicate a live Manifest name", () => {
  const existing = [createEnvironmentVariable(sharedDraft, "lane-1")];

  expect(validateVariableDraft(sharedDraft, existing)).toContain(
    "already exists",
  );
  expect(
    validateVariableDraft({ ...sharedDraft, name: "NEW_VARIABLE" }, existing),
  ).toBeNull();
});

test("creating a Variable establishes its definition and initial Value lane together", () => {
  const variable = createEnvironmentVariable(sharedDraft, "lane-1");

  expect(variable).toMatchObject({
    id: "lane-1",
    name: "API_ORIGIN",
    ownership: "SHARED_VALUE",
    value: "",
    hasDraftChange: true,
  });
});

test("empty and absent User-defined Values remain distinct", () => {
  const variable = createEnvironmentVariable(
    {
      ...sharedDraft,
      name: "OPTIONAL_TOKEN",
      ownership: "USER_DEFINED_VALUE",
      value: "",
      valuePresent: false,
      required: false,
    },
    "lane-2",
  );

  expect(variable.value).toBeNull();
  expect(
    createEnvironmentVariable(
      {
        ...sharedDraft,
        name: "EMPTY_VALUE",
        value: "",
        valuePresent: true,
        required: false,
      },
      "lane-3",
    ).value,
  ).toBe("");
  expect(updateVariableValue(variable, null).value).toBeNull();

  expect(() =>
    updateVariableValue(
      createEnvironmentVariable(sharedDraft, "required-lane"),
      null,
    ),
  ).toThrow("required Variable");
  expect(() =>
    updateVariableValue(variable, "x".repeat(1024 * 1024 + 1)),
  ).toThrow("1 MiB");
});

test("deleting a Variable leaves a changed tombstone without a Value", () => {
  const variable = createEnvironmentVariable(sharedDraft, "lane-1");
  const tombstone = deleteEnvironmentVariable(variable);

  expect(tombstone).toMatchObject({
    id: "lane-1",
    name: "API_ORIGIN",
    value: null,
    hasDraftChange: true,
    tombstone: true,
  });
  expect(() => updateVariableValue(tombstone, "forbidden")).toThrow(
    "tombstone",
  );
});

test("Manifest validation preserves unique live names and tombstones", () => {
  const variable = createEnvironmentVariable(sharedDraft, "lane-1");
  expect(validateEnvironmentVariables([variable])).toBeNull();
  expect(
    validateEnvironmentVariables([
      variable,
      createEnvironmentVariable({ ...sharedDraft, name: "SECOND" }, "lane-2"),
    ]),
  ).toBeNull();
  expect(
    validateEnvironmentVariables([variable, { ...variable, id: "lane-2" }]),
  ).toContain("duplicate live Variable name");
  expect(
    validateEnvironmentVariables([
      deleteEnvironmentVariable(variable),
      { ...variable, id: "lane-2", tombstone: true, value: "stale" },
    ]),
  ).toContain("tombstone cannot retain a Value");
});

test("changed lane count supports a publication review", () => {
  const unchanged = {
    ...createEnvironmentVariable(sharedDraft, "lane-1"),
    hasDraftChange: false,
  };
  const changed = createEnvironmentVariable(
    { ...sharedDraft, name: "SIGNING_KEY" },
    "lane-2",
  );

  expect(changedLaneCount([unchanged, changed])).toBe(1);
});

test("publication preparation encrypts changed lanes and signs the mutation digest", async () => {
  const preparation = await prepareEncryptedPublication([
    createEnvironmentVariable(
      { ...sharedDraft, value: "local-only" },
      "lane-1",
    ),
  ]);

  expect(preparation).toMatchObject({
    encryptedLaneCount: 1,
    servicePlaintextBytes: 0,
    signatureBytes: 64,
  });
  expect(preparation.laneCiphertextHashes).toHaveLength(1);
  expect(preparation.mutationSignature).toHaveLength(64);
  expect(preparation.encryptedBytes).toBeGreaterThan(0);
});

test("publication preparation rejects a Manifest that breaks required lanes", async () => {
  const requiredWithoutValue = {
    ...createEnvironmentVariable(sharedDraft, "lane-1"),
    value: null,
  };

  await expect(
    prepareEncryptedPublication([requiredWithoutValue]),
  ).rejects.toThrow("required Variable");
});

test("publication preparation signs tombstones without encrypting them as empty Values", async () => {
  const tombstone = deleteEnvironmentVariable(
    createEnvironmentVariable(sharedDraft, "lane-1"),
  );
  const preparation = await prepareEncryptedPublication([tombstone]);

  expect(preparation).toMatchObject({
    encryptedLaneCount: 0,
    tombstoneLaneCount: 1,
    servicePlaintextBytes: 0,
  });
  expect(preparation.tombstoneVariableIds).toEqual(["lane-1"]);
  expect(preparation.laneCiphertextHashes).toHaveLength(0);
});

test("publication mutation is derived from the verified head, not session state", () => {
  expect(publicationMutationForHead({ expectedHeadId: null })).toBe("GENESIS");
  expect(publicationMutationForHead({ expectedHeadId: "rev_0185" })).toBe(
    "MANIFEST_UPDATE",
  );
  expect(
    publicationMutationForHead({
      expectedHeadId: "rev_0185",
      rollbackTargetId: "rev_0183",
    }),
  ).toBe("ROLLBACK");
  expect(
    publicationMutationForHead({
      expectedHeadId: null,
      rollbackTargetId: "rev_0183",
    }),
  ).toBe("ROLLBACK");
});

test("rollback plans select lanes and never rewind the Environment head", () => {
  expect(createRollbackPlan("rev_0183", ["lane-1"])).toEqual({
    targetRevision: "rev_0183",
    selectedVariableIds: ["lane-1"],
    appendOnly: true,
  });
});

test("rollback applies only selected historical lanes while retaining the current head", () => {
  const variables = [
    createEnvironmentVariable({ ...sharedDraft, value: "current-a" }, "lane-1"),
    createEnvironmentVariable(
      { ...sharedDraft, name: "SECOND", value: "current-b" },
      "lane-2",
    ),
  ];
  const rolledBack = applyRollbackToVariables(
    variables,
    new Map([
      ["lane-1", "historical-a"],
      ["lane-2", "historical-b"],
    ]),
    ["lane-1"],
  );

  expect(rolledBack[0]?.value).toBe("historical-a");
  expect(rolledBack[1]?.value).toBe("current-b");
  expect(rolledBack[0]?.hasDraftChange).toBe(true);
});

test("restoring the published Value is not a draft change", () => {
  const published = {
    ...createEnvironmentVariable({ ...sharedDraft, value: "live" }, "lane-1"),
    hasDraftChange: false,
  };
  const edited = updateVariableValue(published, "scratch");

  expect(variableHasDraftChange(edited, published)).toBe(true);
  expect(
    variableHasDraftChange(updateVariableValue(edited, "live"), published),
  ).toBe(false);
});

test("a delayed verified read adopts the remote baseline without discarding local work", () => {
  const remoteOrigin = {
    ...createEnvironmentVariable({ ...sharedDraft, value: "remote" }, "lane-1"),
    hasDraftChange: false,
  };
  const remoteOptional = {
    ...createEnvironmentVariable(
      {
        ...sharedDraft,
        name: "OPTIONAL_FLAG",
        value: "",
        valuePresent: false,
        required: false,
      },
      "lane-2",
    ),
    hasDraftChange: false,
  };
  const remote = [remoteOrigin, remoteOptional];

  expect(mergeDraftVariablesOverRemote([], remote)).toEqual(remote);
});

test("typing before a delayed initial response keeps the edit over the arriving page", () => {
  const remoteOrigin = {
    ...createEnvironmentVariable({ ...sharedDraft, value: "remote" }, "lane-1"),
    hasDraftChange: false,
  };
  const remoteOptional = {
    ...createEnvironmentVariable(
      {
        ...sharedDraft,
        name: "OPTIONAL_FLAG",
        value: "",
        valuePresent: false,
        required: false,
      },
      "lane-2",
    ),
    hasDraftChange: false,
  };
  const localOrigin = {
    ...remoteOrigin,
    value: "typed-before-the-response",
    hasDraftChange: true,
  };
  const createdEarly = createEnvironmentVariable(
    { ...sharedDraft, name: "LATE_ADDITION", value: "added" },
    "lane-3",
  );
  const deletedEarly = {
    ...deleteEnvironmentVariable(remoteOptional),
    hasDraftChange: true,
  };

  const merged = mergeDraftVariablesOverRemote(
    [localOrigin, deletedEarly, createdEarly],
    [remoteOrigin, remoteOptional],
  );

  expect(merged.map((variable) => variable.id)).toEqual([
    "lane-1",
    "lane-2",
    "lane-3",
  ]);
  expect(merged[0]).toMatchObject({
    id: "lane-1",
    value: "typed-before-the-response",
    hasDraftChange: true,
  });
  expect(merged[1]).toMatchObject({
    id: "lane-2",
    tombstone: true,
    hasDraftChange: true,
  });
  expect(merged[2]).toMatchObject({
    id: "lane-3",
    name: "LATE_ADDITION",
    hasDraftChange: true,
  });
  expect(changedLaneCount(merged)).toBe(3);
});

test("an unchanged local Variable deleted remotely is not republished on merge", () => {
  const remoteOrigin = {
    ...createEnvironmentVariable({ ...sharedDraft, value: "remote" }, "lane-1"),
    hasDraftChange: false,
  };
  const editedOrigin = {
    ...remoteOrigin,
    value: "edited-locally",
    hasDraftChange: true,
  };
  const remotelyDeleted = {
    ...createEnvironmentVariable(
      {
        ...sharedDraft,
        name: "OPTIONAL_FLAG",
        value: "",
        valuePresent: false,
        required: false,
      },
      "lane-2",
    ),
    hasDraftChange: false,
  };
  const createdEarly = createEnvironmentVariable(
    { ...sharedDraft, name: "LATE_ADDITION", value: "added" },
    "lane-3",
  );

  const merged = mergeDraftVariablesOverRemote(
    [editedOrigin, remotelyDeleted, createdEarly],
    [remoteOrigin],
  );

  expect(merged.map((variable) => variable.id)).toEqual(["lane-1", "lane-3"]);
  expect(merged[0]).toMatchObject({
    id: "lane-1",
    value: "edited-locally",
    hasDraftChange: true,
  });
  expect(merged[1]).toMatchObject({
    id: "lane-3",
    name: "LATE_ADDITION",
    hasDraftChange: true,
  });
});

test("an edit that matches the verified remote page is not a pending change", () => {
  const remoteOrigin = {
    ...createEnvironmentVariable({ ...sharedDraft, value: "remote" }, "lane-1"),
    hasDraftChange: false,
  };
  const localOrigin = { ...remoteOrigin, hasDraftChange: true };

  const merged = mergeDraftVariablesOverRemote([localOrigin], [remoteOrigin]);

  expect(merged[0]).toMatchObject({
    id: "lane-1",
    value: "remote",
    hasDraftChange: false,
  });
});

test("a publish clears only confirmed lanes and keeps mid-flight edits unpublished", () => {
  const publishedOrigin = {
    ...createEnvironmentVariable(
      { ...sharedDraft, value: "published" },
      "lane-1",
    ),
    hasDraftChange: true,
  };
  const publishedOptional = {
    ...createEnvironmentVariable(
      { ...sharedDraft, name: "OPTIONAL_FLAG", value: "baseline" },
      "lane-2",
    ),
    hasDraftChange: false,
  };
  const snapshot = [publishedOrigin, publishedOptional];

  // After the snapshot was submitted, the user edited OPTIONAL_FLAG again and
  // left API_ORIGIN untouched.
  const current = [
    { ...publishedOrigin, hasDraftChange: true },
    { ...publishedOptional, value: "mid-flight-edit", hasDraftChange: true },
  ];

  const settled = settlePublishedDraft(current, snapshot);

  expect(settled[0]).toMatchObject({ id: "lane-1", hasDraftChange: false });
  expect(settled[1]).toMatchObject({
    id: "lane-2",
    value: "mid-flight-edit",
    hasDraftChange: true,
  });
});

test("Variables added after the published snapshot stay an unpublished draft", () => {
  const publishedOrigin = {
    ...createEnvironmentVariable(
      { ...sharedDraft, value: "published" },
      "lane-1",
    ),
    hasDraftChange: true,
  };
  const snapshot = [publishedOrigin];
  const addedLate = createEnvironmentVariable(
    { ...sharedDraft, name: "LATE_ADDITION", value: "added" },
    "lane-2",
  );
  const current = [publishedOrigin, addedLate];

  const settled = settlePublishedDraft(current, snapshot);

  expect(settled[0]).toMatchObject({ id: "lane-1", hasDraftChange: false });
  expect(settled[1]).toMatchObject({
    id: "lane-2",
    name: "LATE_ADDITION",
    hasDraftChange: true,
  });
});

test("a Variable deleted after the published snapshot stays an unpublished draft", () => {
  const publishedOptional = {
    ...createEnvironmentVariable(
      {
        ...sharedDraft,
        name: "OPTIONAL_FLAG",
        value: "kept",
        valuePresent: true,
        required: false,
      },
      "lane-1",
    ),
    hasDraftChange: false,
  };
  const snapshot = [publishedOptional];
  const current = [deleteEnvironmentVariable(publishedOptional)];

  const settled = settlePublishedDraft(current, snapshot);

  expect(settled[0]).toMatchObject({
    id: "lane-1",
    tombstone: true,
    hasDraftChange: true,
  });
});

test("the remote baseline resets to the published snapshot, not newer local Values", () => {
  const changed = {
    ...createEnvironmentVariable(
      { ...sharedDraft, value: "published" },
      "lane-1",
    ),
    hasDraftChange: true,
  };
  const unchanged = {
    ...createEnvironmentVariable(
      { ...sharedDraft, name: "SAME", value: "same" },
      "lane-2",
    ),
    hasDraftChange: false,
  };

  const baseline = publishedBaseline([changed, unchanged]);

  expect(baseline[0]).toMatchObject({
    id: "lane-1",
    value: "published",
    hasDraftChange: false,
  });
  expect(baseline[1]).toMatchObject({
    id: "lane-2",
    value: "same",
    hasDraftChange: false,
  });
});

test("draft diffs describe added, changed, and deleted Variables", () => {
  const published = {
    ...createEnvironmentVariable({ ...sharedDraft, value: "live" }, "lane-1"),
    hasDraftChange: false,
  };
  const changed = updateVariableValue(published, "next");
  const added = createEnvironmentVariable(
    { ...sharedDraft, name: "NEW_TOKEN", value: "secret" },
    "lane-2",
  );
  const removed = deleteEnvironmentVariable(published);

  expect(draftValueDiffs([changed, added, removed], [published])).toEqual([
    { id: "lane-1", name: "API_ORIGIN", from: "live", to: "next" },
    { id: "lane-2", name: "NEW_TOKEN", from: undefined, to: "secret" },
    { id: "lane-1", name: "API_ORIGIN", from: "live", to: undefined },
  ]);
});

test("conflicts are classified by Value, definition, and deletion changes", () => {
  const local = {
    ...createEnvironmentVariable({ ...sharedDraft, value: "mine" }, "lane-1"),
    hasDraftChange: true,
  };
  const valueOnly: EnvironmentVariable = {
    ...local,
    value: "theirs",
    hasDraftChange: false,
  };
  const definitionOnly: EnvironmentVariable = {
    ...local,
    value: "mine",
    description: "Their description.",
    hasDraftChange: false,
  };
  const ownershipChange: EnvironmentVariable = {
    ...local,
    ownership: "USER_DEFINED_VALUE",
    hasDraftChange: false,
  };
  const deletedLocally: EnvironmentVariable = {
    ...local,
    value: null,
    tombstone: true,
    hasDraftChange: true,
  };
  const deletedRemotely: EnvironmentVariable = {
    ...local,
    value: null,
    tombstone: true,
    hasDraftChange: false,
  };

  expect(summarizeConflict(local, valueOnly).kinds).toEqual(["value"]);
  expect(summarizeConflict(local, definitionOnly).kinds).toEqual([
    "definition",
  ]);
  expect(summarizeConflict(local, ownershipChange).kinds).toEqual([
    "definition",
  ]);
  // Local deleted a Variable the remote still keeps.
  expect(summarizeConflict(deletedLocally, local).kinds).toEqual(["deletion"]);
  // Remote deleted a Variable the local still keeps.
  expect(summarizeConflict(local, deletedRemotely).kinds).toEqual(["deletion"]);
  // A deletion also changes the Value lane, but the deletion is the headline.
  expect(
    summarizeConflict({ ...deletedLocally, value: "stale" }, local).kinds,
  ).toEqual(["deletion"]);
  // No verified remote side: nothing can be classified.
  expect(summarizeConflict(local, null).kinds).toEqual([]);
});

test("keeping mine preserves the local definition and Value", () => {
  const local = {
    ...createEnvironmentVariable({ ...sharedDraft, value: "mine" }, "lane-1"),
    hasDraftChange: true,
  };
  const remote: EnvironmentVariable = {
    ...local,
    value: "theirs",
    hasDraftChange: false,
  };

  const resolved = applyConflictResolution(local, remote, "local");
  expect(resolved).toMatchObject({
    id: "lane-1",
    value: "mine",
    description: local.description,
    ownership: local.ownership,
    tombstone: local.tombstone,
    hasDraftChange: true,
  });
});

test("using theirs adopts the remote definition and Value", () => {
  const local = {
    ...createEnvironmentVariable(
      { ...sharedDraft, value: "mine", description: "Mine." },
      "lane-1",
    ),
    hasDraftChange: true,
  };
  const remote: EnvironmentVariable = {
    ...local,
    value: "theirs",
    description: "Theirs.",
    hasDraftChange: false,
  };

  const resolved = applyConflictResolution(local, remote, "remote");
  expect(resolved).toMatchObject({
    id: "lane-1",
    value: "theirs",
    description: "Theirs.",
    hasDraftChange: true,
  });
});

test("keeping my value merges the remote definition with the local Value", () => {
  const local = {
    ...createEnvironmentVariable(
      { ...sharedDraft, value: "mine", description: "Mine." },
      "lane-1",
    ),
    hasDraftChange: true,
  };
  const remote: EnvironmentVariable = {
    ...local,
    value: "theirs",
    description: "Theirs.",
    ownership: "USER_DEFINED_VALUE",
    hasDraftChange: false,
  };

  const resolved = applyConflictResolution(local, remote, "merge");
  expect(resolved).toMatchObject({
    id: "lane-1",
    value: "mine",
    description: "Theirs.",
    ownership: "USER_DEFINED_VALUE",
    hasDraftChange: true,
  });
});

test("a resolution without a verified remote side keeps the local Variable", () => {
  const local = {
    ...createEnvironmentVariable({ ...sharedDraft, value: "mine" }, "lane-1"),
    hasDraftChange: true,
  };

  for (const choice of ["local", "remote", "merge"] as const) {
    const resolved = applyConflictResolution(local, null, choice);
    expect(resolved).toMatchObject({
      id: "lane-1",
      value: "mine",
      hasDraftChange: true,
    });
  }
});

test("keeping my value on a deleted Variable keeps the deletion", () => {
  const local = {
    ...createEnvironmentVariable({ ...sharedDraft, value: "mine" }, "lane-1"),
    hasDraftChange: true,
  };
  const deleted = {
    ...local,
    value: null,
    tombstone: true,
    hasDraftChange: true,
  };
  const remote: EnvironmentVariable = {
    ...local,
    value: "theirs",
    description: "Theirs.",
    hasDraftChange: false,
  };

  const resolved = applyConflictResolution(deleted, remote, "merge");
  expect(resolved).toMatchObject({
    id: "lane-1",
    value: null,
    tombstone: true,
    description: "Theirs.",
  });
});

test("inline value diffs keep the shared characters and mark only the edit", () => {
  expect(splitInlineValueDiff("abc", "abcd")).toEqual({
    prefix: "abc",
    removed: "",
    added: "d",
    suffix: "",
  });
  expect(
    splitInlineValueDiff("postgres://old@host/db", "postgres://new@host/db"),
  ).toEqual({
    prefix: "postgres://",
    removed: "old",
    added: "new",
    suffix: "@host/db",
  });
});

const revision = (
  id: string,
  overrides: Partial<Omit<VerifiedRevision, "id">> = {},
): VerifiedRevision => ({
  id,
  parentId: null,
  mutation: null,
  projectEpoch: null,
  authoredAtMs: null,
  rollbackTargetId: null,
  authorUserId: null,
  ...overrides,
});

test("verified history keeps existing revisions when a sync page is empty", () => {
  expect(
    mergeVerifiedHistory([revision("rev_1"), revision("rev_2")], []),
  ).toEqual([revision("rev_1"), revision("rev_2")]);
});

test("verified history appends new revisions without duplicating", () => {
  expect(
    mergeVerifiedHistory(
      [revision("rev_1"), revision("rev_2")],
      [revision("rev_2"), revision("rev_3")],
    ),
  ).toEqual([revision("rev_1"), revision("rev_2"), revision("rev_3")]);
});

test("a wire Revision keeps its verified context and an unavailable author", () => {
  expect(
    verifiedRevisionFromWire({
      id: "rev_0183",
      parentId: "rev_0182",
      mutation: 2,
      projectEpoch: 1n,
      authoredAtMs: 1750000000000n,
      rollbackTargetId: null,
    }),
  ).toEqual(
    revision("rev_0183", {
      parentId: "rev_0182",
      mutation: 2,
      projectEpoch: 1,
      authoredAtMs: 1750000000000,
    }),
  );
  expect(
    verifiedRevisionFromWire({
      id: "rev_0184",
      parentId: "rev_0183",
      mutation: 3,
      projectEpoch: 1n,
      authoredAtMs: 1750000000001n,
      rollbackTargetId: "rev_0181",
    }).authorUserId,
  ).toBeNull();
});

test("a locally published Revision is authored by the acting User", () => {
  expect(
    locallyPublishedRevision({
      id: "rev_0185",
      parentId: "rev_0184",
      mutation: "ROLLBACK",
      projectEpoch: 2,
      authoredAtMs: 1750000000000,
      rollbackTargetId: "rev_0183",
      authorUserId: "00000000-0000-4000-8000-000000000061",
    }),
  ).toEqual(
    revision("rev_0185", {
      parentId: "rev_0184",
      mutation: 3,
      projectEpoch: 2,
      authoredAtMs: 1750000000000,
      rollbackTargetId: "rev_0183",
      authorUserId: "00000000-0000-4000-8000-000000000061",
    }),
  );
  expect(
    locallyPublishedRevision({
      id: "rev_0186",
      parentId: null,
      mutation: "GENESIS",
      projectEpoch: 1,
      authoredAtMs: 1750000000000,
      authorUserId: "user",
    }).mutation,
  ).toBe(1);
});

test("revision mutation kinds map to readable labels", () => {
  expect(revisionMutationLabel(1)).toBe("First publish");
  expect(revisionMutationLabel(2)).toBe("Update");
  expect(revisionMutationLabel(3)).toBe("Rollback");
  expect(revisionMutationLabel(4)).toBe("Project keys rotated");
  expect(revisionMutationLabel(5)).toBe("Keys rotated");
  expect(revisionMutationLabel(null)).toBeNull();
  expect(revisionMutationLabel(99)).toBeNull();
});

test("a bare Revision reports every piece of context as unavailable", () => {
  expect(bareVerifiedRevision("rev_0183")).toEqual(revision("rev_0183"));
});

test("rollback diffs omit Variables whose Values already match history", () => {
  const current = [
    {
      ...createEnvironmentVariable({ ...sharedDraft, value: "now" }, "lane-1"),
      hasDraftChange: false,
    },
    {
      ...createEnvironmentVariable(
        { ...sharedDraft, name: "SAME", value: "kept" },
        "lane-2",
      ),
      hasDraftChange: false,
    },
  ];

  expect(
    rollbackValueDiffs(
      current,
      new Map([
        ["lane-1", "then"],
        ["lane-2", "kept"],
      ]),
    ),
  ).toEqual([{ id: "lane-1", name: "API_ORIGIN", from: "now", to: "then" }]);
});

test("rollback refuses a selected lane without verified historical state", () => {
  const variable = createEnvironmentVariable(sharedDraft, "lane-1");

  expect(() =>
    applyRollbackToVariables(variable ? [variable] : [], new Map(), ["lane-1"]),
  ).toThrow("historical Value");
});

test("a verified rollback history read reports absence without failure", async () => {
  const resolve = async (input: {
    targetRevision: string;
    selectedVariableIds: readonly string[];
  }) => {
    expect(input.targetRevision).toBe("rev_0183");
    // lane-2 is verified absent from the Revision: the read succeeds and
    // simply omits it.
    return new Map<string, string | null>([
      ["lane-1", "then"],
      ["lane-3", null],
    ]);
  };

  const result = await loadRollbackHistory(resolve, {
    targetRevision: "rev_0183",
    variableIds: ["lane-1", "lane-2", "lane-3"],
  });

  expect(result.values.get("lane-1")).toBe("then");
  expect(result.values.has("lane-2")).toBe(false);
  expect(result.values.get("lane-3")).toBeNull();
  expect(result.unresolvedVariableIds).toEqual([]);
});

test("a failed bulk history read salvages readable Variables and names the rest unresolved", async () => {
  const resolve = async (input: {
    targetRevision: string;
    selectedVariableIds: readonly string[];
  }) => {
    if (input.selectedVariableIds.length > 1)
      throw new Error("integrity verification failed");
    const variableId = input.selectedVariableIds[0] ?? "";
    if (variableId === "lane-3") throw new Error("value could not be opened");
    if (variableId === "lane-2") return new Map<string, string | null>();
    return new Map<string, string | null>([[variableId, "then"]]);
  };

  const result = await loadRollbackHistory(resolve, {
    targetRevision: "rev_0183",
    variableIds: ["lane-1", "lane-2", "lane-3"],
  });

  expect(result.values.get("lane-1")).toBe("then");
  // lane-2 verified absent on retry is not unresolved; lane-3 still failed.
  expect(result.values.has("lane-2")).toBe(false);
  expect(result.unresolvedVariableIds).toEqual(["lane-3"]);
});

test("an unreadable history reports every Variable unresolved", async () => {
  const resolve = async () => {
    throw new Error("verified historical Revision is not present");
  };

  const result = await loadRollbackHistory(resolve, {
    targetRevision: "rev_0183",
    variableIds: ["lane-1", "lane-2"],
  });

  expect(result.values.size).toBe(0);
  expect(result.unresolvedVariableIds).toEqual(["lane-1", "lane-2"]);
});

const blockedSetup = {
  sessionActive: false,
  profileTrusted: false,
  cryptoAvailable: false,
  deviceActive: false,
  grantsReady: false,
  resourceActive: false,
  epochCurrent: false,
  rotationRequired: true,
} as const;

test("setup reports only the next action the person can take", () => {
  expect(nextSetupAction(blockedSetup)?.id).toBe("sign-in");
  expect(nextSetupAction({ ...blockedSetup, sessionActive: true })?.id).toBe(
    "trust-profile",
  );
  expect(
    nextSetupAction({
      ...blockedSetup,
      sessionActive: true,
      profileTrusted: true,
    })?.id,
  ).toBe("crypto-unavailable");
  expect(
    nextSetupAction({
      ...blockedSetup,
      sessionActive: true,
      profileTrusted: true,
      cryptoAvailable: true,
    })?.id,
  ).toBe("enroll-device");
  expect(
    nextSetupAction({
      ...blockedSetup,
      sessionActive: true,
      profileTrusted: true,
      cryptoAvailable: true,
    })?.body,
  ).toContain("separate device");
  expect(
    nextSetupAction({
      sessionActive: true,
      profileTrusted: true,
      cryptoAvailable: true,
      deviceActive: true,
      grantsReady: true,
      resourceActive: true,
      epochCurrent: true,
      rotationRequired: false,
    }),
  ).toBeNull();
  expect(displayedSetupAction(null, { localDeviceBlockers: true })?.id).toBe(
    "enroll-device",
  );
});

test("privileged Team roles may change every Value and the Manifest definition", () => {
  const shared = createEnvironmentVariable(sharedDraft, "lane-1");
  const owned = createEnvironmentVariable(
    { ...sharedDraft, name: "MY_TOKEN", ownership: "USER_DEFINED_VALUE" },
    "lane-2",
  );

  for (const role of ["OWNER", "ADMIN"] as const) {
    expect(roleLabel(role)).not.toBe("Member");
    expect(canActorChangeDefinitions({ role, actorUserId: null })).toBe(true);
    expect(
      canActorChangeVariableValue({ role, actorUserId: null }, shared),
    ).toBe(true);
    expect(
      canActorChangeVariableValue({ role, actorUserId: "u-2" }, owned),
    ).toBe(true);
  }
});

test("a Member may change only the Values they provided or own", () => {
  const provided = createEnvironmentVariable(sharedDraft, "lane-1", {
    actorUserId: "u-1",
  });
  const foreignShared = createEnvironmentVariable(
    { ...sharedDraft, name: "OTHER" },
    "lane-2",
    { actorUserId: "u-2" },
  );
  const ownToken = createEnvironmentVariable(
    { ...sharedDraft, name: "MY_TOKEN", ownership: "USER_DEFINED_VALUE" },
    "lane-3",
    { actorUserId: "u-1" },
  );
  const foreignToken = createEnvironmentVariable(
    { ...sharedDraft, name: "THEIR_TOKEN", ownership: "USER_DEFINED_VALUE" },
    "lane-4",
    { actorUserId: "u-2" },
  );
  const member = { role: "MEMBER" as const, actorUserId: "u-1" };

  expect(canActorChangeVariableValue(member, provided)).toBe(true);
  expect(canActorChangeVariableValue(member, foreignShared)).toBe(false);
  expect(canActorChangeVariableValue(member, ownToken)).toBe(true);
  expect(canActorChangeVariableValue(member, foreignToken)).toBe(false);
  expect(
    canActorChangeVariableValue(
      { role: "MEMBER", actorUserId: null },
      provided,
    ),
  ).toBe(false);
  expect(canActorChangeDefinitions(member)).toBe(false);
});

test("creating a Variable records the acting User as provider or owner", () => {
  const shared = createEnvironmentVariable(sharedDraft, "lane-1", {
    actorUserId: "u-1",
  });
  expect(shared.originalProviderUserId).toBe("u-1");
  expect(shared.ownerUserId).toBeUndefined();

  const owned = createEnvironmentVariable(
    { ...sharedDraft, name: "MY_TOKEN", ownership: "USER_DEFINED_VALUE" },
    "lane-2",
    { actorUserId: "u-1" },
  );
  expect(owned.ownerUserId).toBe("u-1");
  expect(owned.originalProviderUserId).toBeUndefined();

  const absent = createEnvironmentVariable(
    {
      ...sharedDraft,
      name: "OPTIONAL_FLAG",
      value: "",
      valuePresent: false,
      required: false,
    },
    "lane-3",
    { actorUserId: "u-1" },
  );
  expect(absent.originalProviderUserId).toBeUndefined();
  expect(absent.ownerUserId).toBeUndefined();
});

test("read-only Variables carry a reason for their locked controls", () => {
  const provided = createEnvironmentVariable(sharedDraft, "lane-1", {
    actorUserId: "u-1",
  });
  const foreignShared = createEnvironmentVariable(
    { ...sharedDraft, name: "OTHER" },
    "lane-2",
    { actorUserId: "u-2" },
  );
  const foreignToken = createEnvironmentVariable(
    { ...sharedDraft, name: "THEIR_TOKEN", ownership: "USER_DEFINED_VALUE" },
    "lane-3",
    { actorUserId: "u-2" },
  );
  const member = { role: "MEMBER" as const, actorUserId: "u-1" };

  expect(readOnlyReason(member, provided)).toBeNull();
  expect(readOnlyReason(member, foreignShared)).toBe(
    "Only the person who provided it, or a team admin, can change it.",
  );
  expect(readOnlyReason(member, foreignToken)).toBe(
    "This value belongs to another user's account.",
  );
  expect(
    readOnlyReason({ role: "ADMIN", actorUserId: null }, foreignShared),
  ).toBeNull();
});

test("a permission change drops uncovered draft lanes and keeps the rest", () => {
  const provided = {
    ...createEnvironmentVariable(sharedDraft, "lane-1", { actorUserId: "u-1" }),
    hasDraftChange: false,
  };
  const foreignBaseline = {
    ...createEnvironmentVariable(
      { ...sharedDraft, name: "OTHER", value: "remote" },
      "lane-2",
      { actorUserId: "u-2" },
    ),
    hasDraftChange: false,
  };
  const foreignEdit = {
    ...foreignBaseline,
    value: "foreign-edit",
    hasDraftChange: true,
  };
  const localAddition = createEnvironmentVariable(
    { ...sharedDraft, name: "LATE_ADDITION" },
    "lane-3",
    { actorUserId: "u-1" },
  );
  const draft = [provided, foreignEdit, localAddition];
  const remote = [provided, foreignBaseline];

  const asMember = reconcileDraftWithPermissions(draft, remote, {
    role: "MEMBER",
    actorUserId: "u-1",
  });
  expect(asMember.droppedVariableNames).toEqual(["OTHER", "LATE_ADDITION"]);
  expect(asMember.variables.map((variable) => variable.id)).toEqual([
    "lane-1",
    "lane-2",
  ]);
  expect(asMember.variables[1]).toMatchObject({
    id: "lane-2",
    value: "remote",
    hasDraftChange: false,
  });

  const asOwner = reconcileDraftWithPermissions(draft, remote, {
    role: "OWNER",
    actorUserId: "u-1",
  });
  expect(asOwner.droppedVariableNames).toEqual([]);
  expect(asOwner.variables.map((variable) => variable.id)).toEqual([
    "lane-1",
    "lane-2",
    "lane-3",
  ]);
});

test("a Member cannot keep a deletion draft after losing admin rights", () => {
  const baseline = {
    ...createEnvironmentVariable(
      {
        ...sharedDraft,
        name: "OPTIONAL_FLAG",
        value: "kept",
        valuePresent: true,
        required: false,
      },
      "lane-4",
      { actorUserId: "u-2" },
    ),
    hasDraftChange: false,
  };
  const deleted = {
    ...deleteEnvironmentVariable(baseline),
    hasDraftChange: true,
  };

  const asMember = reconcileDraftWithPermissions([deleted], [baseline], {
    role: "MEMBER",
    actorUserId: "u-1",
  });
  expect(asMember.droppedVariableNames).toEqual(["OPTIONAL_FLAG"]);
  expect(asMember.variables[0]).toMatchObject({
    id: "lane-4",
    value: "kept",
    hasDraftChange: false,
  });
  expect(asMember.variables[0]?.tombstone).toBe(false);

  const asAdmin = reconcileDraftWithPermissions([deleted], [baseline], {
    role: "ADMIN",
    actorUserId: "u-1",
  });
  expect(asAdmin.droppedVariableNames).toEqual([]);
  expect(asAdmin.variables[0]?.tombstone).toBe(true);
test("new Environment labels must be valid and unique among active Environments", () => {
  expect(validateEnvironmentLabel("")).toContain("required");
  expect(validateEnvironmentLabel("staging env")).toContain("letters");
  expect(validateEnvironmentLabel("1staging")).toContain("letters");
  expect(
    validateEnvironmentLabel("staging", ["staging", "production"]),
  ).toContain("already exists");
  expect(validateEnvironmentLabel("staging", ["production"])).toBeNull();
  expect(validateEnvironmentLabel("staging")).toBeNull();
});

test("a new Environment can copy, blank, or omit each source Variable", () => {
  const origin = createEnvironmentVariable(
    { ...sharedDraft, value: "https://api.example" },
    "lane-1",
  );
  const signing = createEnvironmentVariable(
    {
      ...sharedDraft,
      name: "SIGNING_KEY",
      ownership: "USER_DEFINED_VALUE",
      value: "secret-material",
    },
    "lane-2",
  );
  const flag = createEnvironmentVariable(
    {
      ...sharedDraft,
      name: "FEATURE_GATE",
      value: "on",
      required: false,
    },
    "lane-3",
  );
  const removed = deleteEnvironmentVariable(
    createEnvironmentVariable({ ...sharedDraft, name: "OLD_TOKEN" }, "lane-4"),
  );
  const ids = ["env-1", "env-2"];

  const seeded = seedEnvironmentVariables(
    [origin, signing, flag, removed],
    {
      "lane-1": "copy",
      "lane-2": "blank",
      "lane-3": "omit",
    },
    () => ids.shift() ?? "overflow",
  );

  expect(seeded).toHaveLength(2);
  expect(seeded[0]).toMatchObject({
    id: "env-1",
    name: "API_ORIGIN",
    description: origin.description,
    ownership: "SHARED_VALUE",
    value: "https://api.example",
    required: true,
    hasDraftChange: true,
    tombstone: false,
  });
  expect(seeded[1]).toMatchObject({
    id: "env-2",
    name: "SIGNING_KEY",
    ownership: "USER_DEFINED_VALUE",
    value: "",
    required: true,
    hasDraftChange: true,
    tombstone: false,
  });
});

test("an empty Environment seed includes no Variables", () => {
  const origin = createEnvironmentVariable(sharedDraft, "lane-1");

  expect(seedEnvironmentVariables([], {}, () => "env-1")).toEqual([]);
  expect(
    seedEnvironmentVariables([origin], { "lane-1": "omit" }, () => "env-1"),
  ).toEqual([]);
});
