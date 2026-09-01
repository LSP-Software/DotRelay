import {
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  seal,
  sha384,
  sign,
} from "@dotrelay/client";

export type VariableOwnership = "SHARED_VALUE" | "USER_DEFINED_VALUE";

export type EnvironmentVariable = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ownership: VariableOwnership;
  readonly value: string | null;
  readonly required: boolean;
  readonly changed: boolean;
}>;

export type VariableDraft = Readonly<{
  readonly name: string;
  readonly description: string;
  readonly ownership: VariableOwnership | "";
  readonly value: string;
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
  readonly signatureBytes: number;
  readonly servicePlaintextBytes: 0;
}>;

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIABLE_NAME_MAX_BYTES = 256;
const DESCRIPTION_MAX_BYTES = 16 * 1024;

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

export const validateVariableDraft = (draft: VariableDraft): string | null => {
  if (!draft.name.trim()) return "Variable name is required.";
  if (!VARIABLE_NAME_PATTERN.test(draft.name))
    return "Use letters, numbers, and underscores; the first character must be a letter or underscore.";
  if (utf8ByteLength(draft.name) > VARIABLE_NAME_MAX_BYTES)
    return "Variable name exceeds the 256-byte limit.";
  if (!draft.ownership) return "Choose Shared Value or User-defined Value.";
  if (utf8ByteLength(draft.description) > DESCRIPTION_MAX_BYTES)
    return "Description exceeds the 16 KiB limit.";
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
    value: draft.value === "" && !draft.required ? null : draft.value,
    required: draft.required,
    changed: true,
  });
};

export const prepareEncryptedPublication = async (
  variables: readonly EnvironmentVariable[],
): Promise<PublicationPreparation> => {
  const changed = variables.filter((variable) => variable.changed);
  if (changed.length === 0) throw new Error("publication has no changed lanes");
  const recipient = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const ciphertexts: Uint8Array[] = [];
  try {
    for (const variable of changed) {
      const plaintext = new TextEncoder().encode(variable.value ?? "");
      try {
        ciphertexts.push(await seal(plaintext, recipient.publicKey));
      } finally {
        plaintext.fill(0);
      }
    }
    const digestInput = new Uint8Array(
      ciphertexts.reduce((total, ciphertext) => total + ciphertext.length, 0),
    );
    let offset = 0;
    for (const ciphertext of ciphertexts) {
      digestInput.set(ciphertext, offset);
      offset += ciphertext.length;
    }
    const mutationDigest = await sha384(digestInput);
    const signature = await sign(mutationDigest, signing.privateKey);
    digestInput.fill(0);
    return Object.freeze({
      encryptedLaneCount: changed.length,
      encryptedBytes: ciphertexts.reduce(
        (total, ciphertext) => total + ciphertext.length,
        0,
      ),
      signatureBytes: signature.length,
      servicePlaintextBytes: 0,
    });
  } finally {
    for (const ciphertext of ciphertexts) ciphertext.fill(0);
  }
};

export const updateVariableValue = (
  variable: EnvironmentVariable,
  value: string | null,
): EnvironmentVariable => Object.freeze({ ...variable, value, changed: true });

export const changedLaneCount = (
  variables: readonly EnvironmentVariable[],
): number => variables.filter((variable) => variable.changed).length;

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
