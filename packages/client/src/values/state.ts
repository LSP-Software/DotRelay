export type UserDefinedValueState =
  | Readonly<{ readonly kind: "absent" }>
  | Readonly<{ readonly kind: "empty" }>
  | Readonly<{ readonly kind: "present"; readonly ciphertext: Uint8Array }>;

export const absentUserDefinedValue = (): UserDefinedValueState =>
  Object.freeze({ kind: "absent" });

export const emptyUserDefinedValue = (): UserDefinedValueState =>
  Object.freeze({ kind: "empty" });

export const presentUserDefinedValue = (
  ciphertext: Uint8Array,
): UserDefinedValueState => Object.freeze({ kind: "present", ciphertext });

export const classifyUserDefinedValue = (input: {
  readonly required: boolean;
  readonly ciphertext?: Uint8Array | null;
  readonly decryptedUtf8?: string | null;
}): UserDefinedValueState => {
  if (
    !input.required ||
    input.ciphertext === null ||
    input.ciphertext === undefined
  )
    return absentUserDefinedValue();
  if (input.decryptedUtf8 === "") return emptyUserDefinedValue();
  if (!(input.ciphertext instanceof Uint8Array))
    throw new TypeError("ciphertext must be bytes when present");
  return presentUserDefinedValue(input.ciphertext);
};

export const isRevealPermitted = (
  state: UserDefinedValueState,
  boundary: "diagnostics" | "clipboard" | "logs",
): boolean => {
  if (state.kind === "absent") return false;
  if (boundary === "diagnostics") return false;
  return state.kind === "present" || state.kind === "empty";
};
