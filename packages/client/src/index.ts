export * from "./contracts";
export {
  createDevicePrivateBundle,
  type DeviceKeyMaterial,
  type DevicePrivateBundle,
  encodeDevicePrivateBundle,
  loadDeviceKeyMaterial,
  parseDevicePrivateBundle,
} from "./device/bundle";
export {
  assertRevealBoundary,
  createDiagnosticEvent,
  DIAGNOSTIC_FIELD_ALLOWLIST,
  DiagnosticBoundaryError,
  type DiagnosticEvent,
  type DiagnosticFieldName,
  type RevealBoundary,
  serializeDiagnosticEvent,
} from "./diagnostics/event";
export {
  type BrowserDeviceStorage,
  createBrowserDeviceStorage,
  createMemoryDeviceRecordStore,
  resetMemoryDeviceRecordStore,
} from "./storage/browser";
export {
  type CliDeviceStorage,
  createCliDeviceStorage,
  createMemoryCredentialStore,
  resetMemoryCredentialStore,
} from "./storage/cli";
export {
  type CredentialStore,
  credentialAccount,
  type DeviceRecordStore,
  type DeviceStorageScope,
  DOTRELAY_CREDENTIAL_SERVICE,
  type EncryptedDeviceRecord,
  scopeKey,
  zeroize,
} from "./storage/types";
export {
  createWrappingKey,
  exportWrappingKeyMaterial,
  importWrappingKeyMaterial,
  unwrapBytes,
  wipeWrappingKey,
  wrapBytes,
  wrappingAssociatedData,
} from "./storage/wrapping";
export {
  type ManifestCounts,
  manifestCountsFromDescriptor,
  validateManifestDescriptor,
  validateRevisionManifest,
} from "./sync/manifest";
export {
  assertPublicationAccepted,
  isRollbackRevision,
  type PublicationReview,
  reviewPublication,
  validateRollbackRevision,
} from "./sync/publication";
export {
  detectEquivocation,
  type EquivocationReport,
  type ReconciliationInput,
  type ReconciliationOutcome,
  reconcileHead,
} from "./sync/reconcile";
export {
  acknowledgeHistoryTrustReset,
  createTrustedHeadStore,
  HistoryTrustResetRequiredError,
  hashRevisionBytes,
  revisionParentLink,
  type TrustedHead,
  TrustedHeadContinuityError,
  type TrustedHeadStore,
  trustedHeadFromRevision,
} from "./trust/head";
export {
  type ClientCryptoState,
  type ClientTrustPhase,
  createClientCryptoState,
  type KeyGenerationTransition,
  validateKeyGenerationTransition,
} from "./trust/state";
export {
  ProtocolVerificationError,
  verifyGrantDigest,
  verifyRevisionChainLink,
  verifyRevisionIntegrity,
  verifySignedProtocolObject,
} from "./trust/verify";
export {
  absentUserDefinedValue,
  classifyUserDefinedValue,
  emptyUserDefinedValue,
  isRevealPermitted,
  presentUserDefinedValue,
  type UserDefinedValueState,
} from "./values/state";
