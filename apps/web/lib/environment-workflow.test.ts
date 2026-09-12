import { expect, test } from "bun:test";
import {
  applyRollbackToVariables,
  changedLaneCount,
  createEnvironmentVariable,
  createRollbackPlan,
  deleteEnvironmentVariable,
  displayedSetupAction,
  draftValueDiffs,
  mergeDraftVariablesOverRemote,
  mergeVerifiedHistory,
  nextSetupAction,
  prepareEncryptedPublication,
  publicationMutationForHead,
  rollbackValueDiffs,
  splitInlineValueDiff,
  updateVariableValue,
  validateEnvironmentVariables,
  validateVariableDraft,
  variableHasDraftChange,
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
    "Shared Value",
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

test("verified history keeps existing revisions when a sync page is empty", () => {
  expect(mergeVerifiedHistory(["rev_1", "rev_2"], [])).toEqual([
    "rev_1",
    "rev_2",
  ]);
});

test("verified history appends new revisions without duplicating", () => {
  expect(mergeVerifiedHistory(["rev_1", "rev_2"], ["rev_2", "rev_3"])).toEqual([
    "rev_1",
    "rev_2",
    "rev_3",
  ]);
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
  ).toContain("CLI is a different Device");
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
