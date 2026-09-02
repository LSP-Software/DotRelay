import {
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  seal,
  sha384,
  sign,
  validatePublicationVariables,
} from "@dotrelay/client";

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
}>;

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
  if (!draft.ownership) return "Choose Shared Value or User-defined Value.";
  if (utf8ByteLength(draft.description) > DESCRIPTION_MAX_BYTES)
    return "Description exceeds the 16 KiB limit.";
  if (
    draft.valuePresent !== false &&
    utf8ByteLength(draft.value) > VALUE_MAX_BYTES
  )
    return "Value exceeds the 1 MiB limit.";
  if (draft.required && draft.valuePresent === false)
    return "Required Variables must have a Value.";
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
): EnvironmentVariable => {
  const error = validateVariableDraft(draft);
  if (error) throw new Error(error);
  const ownership = draft.ownership;
  if (!ownership) throw new Error("Variable ownership is required.");
  return Object.freeze({
    id,
    name: draft.name,
    description: draft.description,
    ownership,
    value: draft.valuePresent === false ? null : draft.value,
    required: draft.required,
    hasDraftChange: true,
    tombstone: false,
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

export const changedLaneCount = (
  variables: readonly EnvironmentVariable[],
): number => variables.filter((variable) => variable.hasDraftChange).length;

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
  readonly profileTrusted: boolean;
  readonly cryptoAvailable: boolean;
  readonly deviceActive: boolean;
  readonly grantsReady: boolean;
  readonly resourceActive: boolean;
  readonly epochCurrent: boolean;
  readonly rotationRequired: boolean;
}>;

export const protectedWorkflowBlockers = (
  state: ProtectedWorkflowState,
): readonly string[] => {
  const blockers: string[] = [];
  if (!state.profileTrusted) blockers.push("Server Profile trust is required.");
  if (!state.cryptoAvailable)
    blockers.push("The closed v3 cryptographic suite is unavailable.");
  if (!state.deviceActive) blockers.push("An active Device is required.");
  if (!state.grantsReady)
    blockers.push("Required key grants are still pending.");
  if (!state.resourceActive)
    blockers.push("Archived Projects and Environments are read-only.");
  if (!state.epochCurrent) blockers.push("The Project epoch is stale.");
  if (state.rotationRequired)
    blockers.push("Required key rotation must complete before publishing.");
  return Object.freeze(blockers);
};
