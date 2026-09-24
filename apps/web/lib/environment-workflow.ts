import {
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  type PublicationMutationKind,
  type SyncRevisionWire,
  seal,
  sha384,
  sign,
  validatePublicationVariables,
} from "@dotrelay/client";
import type { MembershipRole } from "./workspace-boundary";

export { type InlineValueHunk, splitInlineValueDiff } from "@dotrelay/client";

export type VariableOwnership = "SHARED_VALUE" | "USER_DEFINED_VALUE";

export type EnvironmentVariable = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ownership: VariableOwnership;
  readonly value: string | null;
  readonly required: boolean;
  readonly hasDraftChange: boolean;
  readonly tombstone?: boolean;
  readonly originalProviderUserId?: string | null;
  readonly ownerUserId?: string | null;
}>;

export type EditorActor = Readonly<{
  readonly role: MembershipRole;
  readonly actorUserId: string | null;
}>;

export const isPrivilegedRole = (role: MembershipRole): boolean =>
  role === "OWNER" || role === "ADMIN";

export const roleLabel = (role: MembershipRole): string =>
  role === "OWNER" ? "Owner" : role === "ADMIN" ? "Admin" : "Member";

export const canActorChangeVariableValue = (
  actor: EditorActor,
  variable: Pick<
    EnvironmentVariable,
    "ownership" | "originalProviderUserId" | "ownerUserId"
  >,
): boolean => {
  if (isPrivilegedRole(actor.role)) return true;
  if (actor.actorUserId === null) return false;
  if (variable.ownership === "SHARED_VALUE")
    return variable.originalProviderUserId === actor.actorUserId;
  return variable.ownerUserId === actor.actorUserId;
};

export const canActorChangeDefinitions = (actor: EditorActor): boolean =>
  isPrivilegedRole(actor.role);

export const canActorPublishVariable = (
  actor: EditorActor,
  variable: Pick<
    EnvironmentVariable,
    "tombstone" | "ownership" | "originalProviderUserId" | "ownerUserId"
  >,
  remoteBaseline?: EnvironmentVariable,
): boolean => {
  if (variable.tombstone || remoteBaseline === undefined)
    return canActorChangeDefinitions(actor);
  return canActorChangeVariableValue(actor, variable);
};

export const readOnlyReason = (
  actor: EditorActor,
  variable: Pick<
    EnvironmentVariable,
    "ownership" | "originalProviderUserId" | "ownerUserId"
  >,
): string | null => {
  if (canActorChangeVariableValue(actor, variable)) return null;
  if (variable.ownership === "SHARED_VALUE")
    return "Only the person who provided it, or a team admin, can change it.";
  return "This value belongs to another user's account.";
};

export const reconcileDraftWithPermissions = (
  variables: readonly EnvironmentVariable[],
  remoteVariables: readonly EnvironmentVariable[],
  actor: EditorActor,
): Readonly<{
  readonly variables: readonly EnvironmentVariable[];
  readonly droppedVariableNames: readonly string[];
}> => {
  const remoteById = new Map(
    remoteVariables.map((variable) => [variable.id, variable]),
  );
  const kept: EnvironmentVariable[] = [];
  const droppedVariableNames: string[] = [];
  for (const variable of variables) {
    const baseline = remoteById.get(variable.id);
    if (
      !variable.hasDraftChange ||
      canActorPublishVariable(actor, variable, baseline)
    ) {
      kept.push(variable);
      continue;
    }
    droppedVariableNames.push(variable.name);
    if (baseline) kept.push(baseline);
  }
  return Object.freeze({
    variables: Object.freeze(kept),
    droppedVariableNames: Object.freeze(droppedVariableNames),
  });
};

export type VariableDraft = Readonly<{
  readonly name: string;
  readonly description: string;
  readonly ownership: VariableOwnership | "";
  readonly value: string;
  readonly valuePresent?: boolean;
  readonly required: boolean;
}>;

export type RollbackPlan = Readonly<{
  readonly targetRevision: string;
  readonly selectedVariableIds: readonly string[];
  readonly appendOnly: true;
}>;

export type PublicationPreparation = Readonly<{
  readonly encryptedLaneCount: number;
  readonly encryptedBytes: number;
  readonly laneCiphertextHashes: readonly Uint8Array[];
  readonly mutationSignature: Uint8Array;
  readonly signatureBytes: number;
  readonly servicePlaintextBytes: 0;
  readonly tombstoneLaneCount: number;
  readonly tombstoneVariableIds: readonly string[];
}>;

export const publicationMutationForHead = (
  input: Readonly<{
    readonly expectedHeadId: string | null;
    readonly rollbackTargetId?: string | null;
  }>,
): PublicationMutationKind =>
  input.rollbackTargetId
    ? "ROLLBACK"
    : input.expectedHeadId
      ? "MANIFEST_UPDATE"
      : "GENESIS";

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIABLE_NAME_MAX_BYTES = 256;
const DESCRIPTION_MAX_BYTES = 16 * 1024;
const VALUE_MAX_BYTES = 1024 * 1024;

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

export const validateVariableDraft = (
  draft: VariableDraft,
  existingVariables: readonly Pick<
    EnvironmentVariable,
    "name" | "tombstone"
  >[] = [],
): string | null => {
  if (!draft.name.trim()) return "Variable name is required.";
  if (!VARIABLE_NAME_PATTERN.test(draft.name))
    return "Use letters, numbers, and underscores; the first character must be a letter or underscore.";
  if (utf8ByteLength(draft.name) > VARIABLE_NAME_MAX_BYTES)
    return "Variable name exceeds the 256-byte limit.";
  if (!draft.ownership) return "Choose who can read the value.";
  if (utf8ByteLength(draft.description) > DESCRIPTION_MAX_BYTES)
    return "Description exceeds the 16 KiB limit.";
  if (
    draft.valuePresent !== false &&
    utf8ByteLength(draft.value) > VALUE_MAX_BYTES
  )
    return "Value exceeds the 1 MiB limit.";
  if (draft.required && draft.valuePresent === false)
    return "A required variable can't be left unset.";
  if (
    existingVariables.some(
      (variable) => !variable.tombstone && variable.name === draft.name,
    )
  )
    return `Variable name "${draft.name}" already exists.`;
  return null;
};

export const createEnvironmentVariable = (
  draft: VariableDraft,
  id: string,
  actor?: Readonly<{ readonly actorUserId: string | null }>,
): EnvironmentVariable => {
  const error = validateVariableDraft(draft);
  if (error) throw new Error(error);
  const ownership = draft.ownership;
  if (!ownership) throw new Error("Variable ownership is required.");
  const valuePresent = draft.valuePresent !== false;
  const actorUserId = actor?.actorUserId ?? null;
  return Object.freeze({
    id,
    name: draft.name,
    description: draft.description,
    ownership,
    value: valuePresent ? draft.value : null,
    required: draft.required,
    hasDraftChange: true,
    tombstone: false,
    ...(ownership === "SHARED_VALUE" && valuePresent && actorUserId
      ? { originalProviderUserId: actorUserId }
      : {}),
    ...(ownership === "USER_DEFINED_VALUE" && valuePresent && actorUserId
      ? { ownerUserId: actorUserId }
      : {}),
  });
};

export const validateEnvironmentVariables = (
  variables: readonly EnvironmentVariable[],
): string | null => validatePublicationVariables(variables);

export const deleteEnvironmentVariable = (
  variable: EnvironmentVariable,
): EnvironmentVariable =>
  Object.freeze({
    ...variable,
    value: null,
    hasDraftChange: true,
    tombstone: true,
  });

export const prepareEncryptedPublication = async (
  variables: readonly EnvironmentVariable[],
): Promise<PublicationPreparation> => {
  const validationError = validateEnvironmentVariables(variables);
  if (validationError) throw new Error(validationError);
  const changed = variables.filter((variable) => variable.hasDraftChange);
  if (changed.length === 0) throw new Error("publication has no changed lanes");
  const recipient = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const changedValues = changed.filter(
    (variable) => !variable.tombstone && variable.value !== null,
  );
  const tombstoneVariableIds = changed
    .filter((variable) => variable.tombstone)
    .map((variable) => variable.id);
  const ciphertexts: Uint8Array[] = [];
  const metadata = new TextEncoder().encode(
    JSON.stringify(
      changed.map((variable) => ({
        id: variable.id,
        tombstone: variable.tombstone === true,
        valuePresent: variable.value !== null,
      })),
    ),
  );
  try {
    for (const variable of changedValues) {
      const plaintext = new TextEncoder().encode(variable.value ?? "");
      try {
        ciphertexts.push(await seal(plaintext, recipient.publicKey));
      } finally {
        plaintext.fill(0);
      }
    }
    const digestInput = new Uint8Array(
      ciphertexts.reduce((total, ciphertext) => total + ciphertext.length, 0) +
        metadata.length,
    );
    let offset = 0;
    for (const ciphertext of ciphertexts) {
      digestInput.set(ciphertext, offset);
      offset += ciphertext.length;
    }
    digestInput.set(metadata, offset);
    const mutationDigest = await sha384(digestInput);
    const signature = await sign(mutationDigest, signing.privateKey);
    const laneCiphertextHashes = await Promise.all(
      ciphertexts.map((ciphertext) => sha384(ciphertext)),
    );
    digestInput.fill(0);
    metadata.fill(0);
    return Object.freeze({
      encryptedLaneCount: changedValues.length,
      encryptedBytes: ciphertexts.reduce(
        (total, ciphertext) => total + ciphertext.length,
        0,
      ),
      laneCiphertextHashes: Object.freeze(
        laneCiphertextHashes.map((hash) => new Uint8Array(hash)),
      ),
      mutationSignature: new Uint8Array(signature),
      signatureBytes: signature.length,
      servicePlaintextBytes: 0,
      tombstoneLaneCount: tombstoneVariableIds.length,
      tombstoneVariableIds: Object.freeze([...tombstoneVariableIds]),
    });
  } finally {
    metadata.fill(0);
    for (const ciphertext of ciphertexts) ciphertext.fill(0);
  }
};

export const updateVariableValue = (
  variable: EnvironmentVariable,
  value: string | null,
): EnvironmentVariable => {
  if (variable.tombstone)
    throw new Error("cannot update the Value of a tombstone");
  if (variable.required && value === null)
    throw new Error("required Variable cannot have an absent Value");
  if (value !== null && utf8ByteLength(value) > VALUE_MAX_BYTES)
    throw new Error("Value exceeds the 1 MiB limit");
  return Object.freeze({ ...variable, value, hasDraftChange: true });
};

export const variableHasDraftChange = (
  variable: Pick<EnvironmentVariable, "value" | "tombstone">,
  baseline: Pick<EnvironmentVariable, "value" | "tombstone"> | undefined,
): boolean => {
  if (!baseline) return true;
  return (
    Boolean(variable.tombstone) !== Boolean(baseline.tombstone) ||
    variable.value !== baseline.value
  );
};

export const mergeDraftVariablesOverRemote = (
  localVariables: readonly EnvironmentVariable[],
  remoteVariables: readonly EnvironmentVariable[],
): readonly EnvironmentVariable[] => {
  const remoteById = new Map(
    remoteVariables.map((variable) => [variable.id, variable]),
  );
  const remoteIds = new Set(remoteById.keys());
  const localById = new Map(
    localVariables.map((variable) => [variable.id, variable]),
  );
  const merged = remoteVariables.map((remoteVariable) => {
    const localVariable = localById.get(remoteVariable.id);
    const candidate = localVariable?.hasDraftChange
      ? localVariable
      : remoteVariable;
    return Object.freeze({
      ...candidate,
      hasDraftChange: variableHasDraftChange(
        candidate,
        remoteById.get(candidate.id),
      ),
    });
  });
  const localOnly = localVariables
    .filter(
      (variable) => variable.hasDraftChange && !remoteIds.has(variable.id),
    )
    .map((variable) => Object.freeze({ ...variable, hasDraftChange: true }));
  return Object.freeze([...merged, ...localOnly]);
};

export const settlePublishedDraft = (
  currentVariables: readonly EnvironmentVariable[],
  publishedSnapshot: readonly EnvironmentVariable[],
): EnvironmentVariable[] => {
  const snapshotById = new Map(
    publishedSnapshot.map((variable) => [variable.id, variable]),
  );
  return currentVariables.map((variable) =>
    Object.freeze({
      ...variable,
      hasDraftChange: variableHasDraftChange(
        variable,
        snapshotById.get(variable.id),
      ),
    }),
  );
};

export const publishedBaseline = (
  publishedSnapshot: readonly EnvironmentVariable[],
): readonly EnvironmentVariable[] =>
  Object.freeze(
    publishedSnapshot.map((variable) =>
      Object.freeze({ ...variable, hasDraftChange: false }),
    ),
  );

export type VariableValueDiff = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly from: string | null | undefined;
  readonly to: string | null | undefined;
}>;

export const draftValueDiffs = (
  variables: readonly EnvironmentVariable[],
  baseline: readonly EnvironmentVariable[],
): readonly VariableValueDiff[] => {
  const baselineById = new Map(
    baseline.map((variable) => [variable.id, variable]),
  );
  return Object.freeze(
    variables.flatMap((variable): readonly VariableValueDiff[] => {
      if (!variable.hasDraftChange) return [];
      const previous = baselineById.get(variable.id);
      if (!previous)
        return [
          {
            id: variable.id,
            name: variable.name,
            from: undefined,
            to: variable.tombstone ? undefined : variable.value,
          },
        ];
      if (variable.tombstone)
        return [
          {
            id: variable.id,
            name: variable.name,
            from: previous.value,
            to: undefined,
          },
        ];
      return [
        {
          id: variable.id,
          name: variable.name,
          from: previous.value,
          to: variable.value,
        },
      ];
    }),
  );
};

export const rollbackValueDiffs = (
  variables: readonly EnvironmentVariable[],
  historicalValues: ReadonlyMap<string, string | null>,
): readonly VariableValueDiff[] =>
  Object.freeze(
    variables.flatMap((variable): readonly VariableValueDiff[] => {
      if (!historicalValues.has(variable.id)) return [];
      const to = historicalValues.get(variable.id) ?? null;
      const from = variable.tombstone ? null : variable.value;
      if (from === to) return [];
      return [
        {
          id: variable.id,
          name: variable.name,
          from,
          to,
        },
      ];
    }),
  );

// values holds the Variables verified present at the Revision; a requested
// Variable missing from it was verified absent there. After a failed bulk
// read, unresolvedVariableIds lists the Variables that could not be read at
// all, so a failure is never mistaken for an unchanged or absent Variable.
export type RollbackHistoryResolution = Readonly<{
  readonly values: ReadonlyMap<string, string | null>;
  readonly unresolvedVariableIds: readonly string[];
}>;

export const loadRollbackHistory = async (
  resolve: (
    input: Readonly<{
      readonly targetRevision: string;
      readonly selectedVariableIds: readonly string[];
    }>,
  ) => Promise<ReadonlyMap<string, string | null>>,
  input: Readonly<{
    readonly targetRevision: string;
    readonly variableIds: readonly string[];
  }>,
): Promise<RollbackHistoryResolution> => {
  try {
    const values = await resolve({
      targetRevision: input.targetRevision,
      selectedVariableIds: input.variableIds,
    });
    return { values, unresolvedVariableIds: [] };
  } catch {
    const values = new Map<string, string | null>();
    const unresolvedVariableIds: string[] = [];
    for (const variableId of input.variableIds) {
      try {
        const one = await resolve({
          targetRevision: input.targetRevision,
          selectedVariableIds: [variableId],
        });
        if (one.has(variableId))
          values.set(variableId, one.get(variableId) ?? null);
      } catch {
        unresolvedVariableIds.push(variableId);
      }
    }
    return { values, unresolvedVariableIds };
  }
};

export type ConflictResolution = "local" | "remote" | "merge";

export type ConflictChangeKind = "value" | "definition" | "deletion";

export type ConflictSummary = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly kinds: readonly ConflictChangeKind[];
  readonly local: EnvironmentVariable;
  readonly remote: EnvironmentVariable | null;
}>;

export const summarizeConflict = (
  local: EnvironmentVariable,
  remote: EnvironmentVariable | null,
): ConflictSummary => {
  const kinds = new Set<ConflictChangeKind>();
  if (remote) {
    if (Boolean(local.tombstone) !== Boolean(remote.tombstone))
      kinds.add("deletion");
    if (
      local.ownership !== remote.ownership ||
      local.description !== remote.description ||
      local.name !== remote.name ||
      local.required !== remote.required
    )
      kinds.add("definition");
    if (!local.tombstone && !remote.tombstone && local.value !== remote.value)
      kinds.add("value");
  }
  return Object.freeze({
    id: local.id,
    name: local.name,
    kinds: Object.freeze([...kinds].sort()),
    local,
    remote,
  });
};

export const applyConflictResolution = (
  local: EnvironmentVariable,
  remote: EnvironmentVariable | null,
  choice: ConflictResolution,
): EnvironmentVariable => {
  if (choice === "local")
    return Object.freeze({ ...local, hasDraftChange: true });
  if (!remote) return Object.freeze({ ...local, hasDraftChange: true });
  if (choice === "remote")
    return Object.freeze({ ...remote, id: local.id, hasDraftChange: true });
  return Object.freeze({
    ...remote,
    id: local.id,
    value: local.value,
    tombstone: local.tombstone === true,
    hasDraftChange: true,
  });
};

export const changedLaneCount = (
  variables: readonly EnvironmentVariable[],
): number => variables.filter((variable) => variable.hasDraftChange).length;

export type VerifiedRevision = Readonly<{
  readonly id: string;
  readonly parentId: string | null;
  readonly mutation: number | null;
  readonly projectEpoch: number | null;
  readonly authoredAtMs: number | null;
  readonly rollbackTargetId: string | null;
  readonly authorUserId: string | null;
}>;

const REVISION_MUTATION_LABELS: Readonly<Record<number, string>> =
  Object.freeze({
    1: "First publish",
    2: "Update",
    3: "Rollback",
    4: "Project keys rotated",
    5: "Keys rotated",
  });

const PUBLICATION_MUTATION_KINDS: Readonly<
  Record<PublicationMutationKind, number>
> = Object.freeze({
  GENESIS: 1,
  MANIFEST_UPDATE: 2,
  ROLLBACK: 3,
});

export const revisionMutationLabel = (
  mutation: number | null,
): string | null =>
  mutation === null ? null : (REVISION_MUTATION_LABELS[mutation] ?? null);

export const bareVerifiedRevision = (id: string): VerifiedRevision =>
  Object.freeze({
    id,
    parentId: null,
    mutation: null,
    projectEpoch: null,
    authoredAtMs: null,
    rollbackTargetId: null,
    authorUserId: null,
  });

export const verifiedRevisionFromWire = (
  revision: Pick<
    SyncRevisionWire,
    | "id"
    | "parentId"
    | "mutation"
    | "projectEpoch"
    | "authoredAtMs"
    | "rollbackTargetId"
  >,
): VerifiedRevision =>
  Object.freeze({
    id: revision.id,
    parentId: revision.parentId,
    mutation: revision.mutation,
    projectEpoch: Number(revision.projectEpoch),
    authoredAtMs: Number(revision.authoredAtMs),
    rollbackTargetId: revision.rollbackTargetId,
    // The sync wire record carries no author field, so Revisions received
    // over sync report an unavailable author rather than guessing one.
    authorUserId: null,
  });

export const locallyPublishedRevision = (input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly mutation: PublicationMutationKind;
  readonly projectEpoch: number;
  readonly authoredAtMs: number;
  readonly rollbackTargetId?: string | null;
  readonly authorUserId: string;
}): VerifiedRevision =>
  Object.freeze({
    id: input.id,
    parentId: input.parentId,
    mutation: PUBLICATION_MUTATION_KINDS[input.mutation],
    projectEpoch: input.projectEpoch,
    authoredAtMs: input.authoredAtMs,
    rollbackTargetId: input.rollbackTargetId ?? null,
    authorUserId: input.authorUserId,
  });

export const mergeVerifiedHistory = (
  current: readonly VerifiedRevision[],
  incoming: readonly VerifiedRevision[],
): readonly VerifiedRevision[] => {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((revision) => revision.id));
  const next = [...current];
  for (const revision of incoming) {
    if (seen.has(revision.id)) continue;
    seen.add(revision.id);
    next.push(revision);
  }
  return Object.freeze(next);
};

export const createRollbackPlan = (
  targetRevision: string,
  selectedVariableIds: readonly string[],
): RollbackPlan => {
  if (!targetRevision) throw new Error("rollback target revision is required");
  if (selectedVariableIds.length === 0)
    throw new Error("select at least one lane to roll back");
  return Object.freeze({
    targetRevision,
    selectedVariableIds: Object.freeze([...selectedVariableIds]),
    appendOnly: true,
  });
};

export const applyRollbackToVariables = (
  variables: readonly EnvironmentVariable[],
  historicalValues: ReadonlyMap<string, string | null>,
  selectedVariableIds: readonly string[],
): readonly EnvironmentVariable[] => {
  if (selectedVariableIds.length === 0)
    throw new Error("select at least one lane to roll back");
  const selected = new Set(selectedVariableIds);
  if (selected.size !== selectedVariableIds.length)
    throw new Error("rollback lanes must be unique");
  for (const variableId of selected) {
    if (!variables.some((variable) => variable.id === variableId))
      throw new Error("rollback lane is not part of the Environment");
    if (!historicalValues.has(variableId))
      throw new Error("verified historical Value is missing for rollback lane");
    const variable = variables.find((candidate) => candidate.id === variableId);
    if (variable?.required && historicalValues.get(variableId) === null)
      throw new Error("required Variable cannot roll back to an absent Value");
  }
  return Object.freeze(
    variables.map((variable) =>
      selected.has(variable.id)
        ? Object.freeze({
            ...variable,
            value: historicalValues.get(variable.id) ?? null,
            hasDraftChange: true,
            tombstone: false,
          })
        : variable,
    ),
  );
};

export type ProtectedWorkflowState = Readonly<{
  readonly sessionActive: boolean;
  readonly profileTrusted: boolean;
  readonly cryptoAvailable: boolean;
  readonly deviceActive: boolean;
  readonly grantsReady: boolean;
  readonly resourceActive: boolean;
  readonly epochCurrent: boolean;
  readonly rotationRequired: boolean;
}>;

export type SetupActionId =
  | "sign-in"
  | "trust-profile"
  | "crypto-unavailable"
  | "enroll-device"
  | "pending-grants"
  | "archived"
  | "stale-epoch"
  | "rotation";

export type SetupAction = Readonly<{
  readonly id: SetupActionId;
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string;
}>;

export const nextSetupAction = (
  state: ProtectedWorkflowState,
): SetupAction | null => {
  if (!state.sessionActive)
    return {
      id: "sign-in",
      title: "Sign in",
      body: "GitHub only identifies you. Sign in to see your teams.",
      actionLabel: "Sign in",
    };
  if (!state.profileTrusted)
    return {
      id: "trust-profile",
      title: "Trust this server",
      body: "Make sure this is the DotRelay server you meant to use.",
      actionLabel: "Trust this server",
    };
  if (!state.cryptoAvailable)
    return {
      id: "crypto-unavailable",
      title: "This browser can't decrypt variables",
      body: "DotRelay needs the Web Crypto API. Use an up-to-date Chrome, Firefox, or Safari, or the CLI.",
      actionLabel: "Copy CLI command",
    };
  if (!state.deviceActive)
    return {
      id: "enroll-device",
      title: "Set up this browser",
      body: "This browser needs its own keys before it can read your values. The CLI is a separate device, so setting it up won't read variables here. Keys stay on this machine.",
      actionLabel: "Set up browser",
    };
  if (!state.grantsReady)
    return {
      id: "pending-grants",
      title: "This browser doesn't have the project's keys yet",
      body: "Open the Recovery area to unlock with a recovery method, or accept a Transfer created by `dotrelay device transfer`, to give this browser the project's keys.",
      actionLabel: "Open recovery",
    };
  if (!state.resourceActive)
    return {
      id: "archived",
      title: "This environment is archived",
      body: "History is kept. Restore it to view and edit variables.",
      actionLabel: "Restore environment",
    };
  if (!state.epochCurrent)
    return {
      id: "stale-epoch",
      title: "This project's keys were rotated",
      body: "Recover the current keys on this browser. The recovery reuses the keys this browser already holds and asks for approval only before it replaces the browser's Device.",
      actionLabel: "Recover keys",
    };
  if (state.rotationRequired)
    return {
      id: "rotation",
      title: "Key rotation is still running",
      body: "Wait until it finishes, then refresh.",
      actionLabel: "Refresh",
    };
  return null;
};

export const displayedSetupAction = (
  setupAction: SetupAction | null,
  options: Readonly<{
    readonly localDeviceBlockers: boolean;
    readonly inProgress?: boolean;
  }>,
): SetupAction | null => {
  if (!options.localDeviceBlockers) return setupAction;
  return {
    id: "enroll-device",
    title: "Unlock variables on this browser",
    body: "This browser's keys are missing, so its values stay hidden. Set it up again to read variables here.",
    actionLabel: options.inProgress ? "Setting up…" : "Set up browser",
  };
};

export const protectedWorkflowBlockers = (
  state: ProtectedWorkflowState,
): readonly string[] => {
  const action = nextSetupAction(state);
  return Object.freeze(action ? [action.title] : []);
};
