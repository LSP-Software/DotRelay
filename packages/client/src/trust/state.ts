export type ClientTrustPhase =
  | "profile_untrusted"
  | "runtime_unverified"
  | "device_unprovisioned"
  | "device_active"
  | "continuity_broken"
  | "history_trust_reset_required";

export type ClientCryptoState = Readonly<{
  readonly phase: ClientTrustPhase;
  readonly serverProfileTrusted: boolean;
  readonly runtimeVerified: boolean;
  readonly deviceProvisioned: boolean;
  readonly continuityTrusted: boolean;
}>;

export const createClientCryptoState = (
  phase: ClientTrustPhase,
): ClientCryptoState =>
  Object.freeze({
    phase,
    serverProfileTrusted:
      phase !== "profile_untrusted" && phase !== "runtime_unverified",
    runtimeVerified:
      phase !== "profile_untrusted" && phase !== "runtime_unverified",
    deviceProvisioned:
      phase === "device_active" ||
      phase === "continuity_broken" ||
      phase === "history_trust_reset_required",
    continuityTrusted: phase === "device_active",
  });

export type KeyGenerationTransition = Readonly<{
  readonly previousGeneration: number;
  readonly nextGeneration: number;
  readonly kind: "user_identity" | "recovery" | "user_defined_value";
}>;

export const validateKeyGenerationTransition = (
  transition: KeyGenerationTransition,
): void => {
  if (
    !Number.isSafeInteger(transition.previousGeneration) ||
    !Number.isSafeInteger(transition.nextGeneration) ||
    transition.nextGeneration !== transition.previousGeneration + 1
  )
    throw new Error("key generation must advance by exactly one");
};
