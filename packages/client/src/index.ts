export type { SyncPageWire } from "@dotrelay/contracts";
export * from "./contracts";
export {
  createDeviceBootstrap,
  type DeviceBootstrap,
} from "./device/bootstrap";
export {
  createDevicePrivateBundle,
  type DeviceKeyMaterial,
  type DevicePrivateBundle,
  encodeDevicePrivateBundle,
  loadDeviceKeyMaterial,
  parseDevicePrivateBundle,
} from "./device/bundle";
export {
  createDeviceCertificate,
  createDeviceEnrollmentApproval,
  createDeviceEnrollmentRequest,
  type DeviceEnrollmentApproval,
  type DeviceEnrollmentRequest,
  type DeviceEnrollmentTranscript,
  parseDeviceEnrollmentTranscript,
  verifyDeviceEnrollmentApproval,
} from "./device/enrollment";
export {
  createProjectEpochGrantBootstrap,
  type ProjectEpochGrantBootstrap,
} from "./device/grant-bootstrap";
export {
  createRecoveredDeviceCertificate,
  createRecoveryChallengeProof,
  createRecoveryKit,
  type OpenedRecoveryKit,
  openRecoveryKit,
  type RecoveredDeviceCertificate,
  type RecoveryChallengeProof,
  type RecoveryKit,
  verifyRecoveryChallengeProof,
} from "./device/recovery";
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
  createIndexedDbDeviceRecordStore,
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
  changedVariableIdsFromSyncPage,
  createPublicationArtifacts,
  type DecodedVariable,
  decodeSyncVariables,
  isRollbackRevision,
  openLane,
  type PublicationArtifacts,
  type PublicationContext,
  type PublicationReview,
  type PublicationVariable,
  reviewPublication,
  type StagedPublicationObject,
  validatePublicationVariables,
  validateRollbackRevision,
  verifySyncPage,
} from "./sync/publication";
export {
  detectEquivocation,
  type EquivocationReport,
  type ReconciliationInput,
  type ReconciliationOutcome,
  reconcileHead,
} from "./sync/reconcile";
export {
  createVerifiedEnvironmentSession,
  type VerifiedEnvironmentSession,
} from "./sync/session";
export {
  type BeginInput,
  type BeginResult,
  type CancelInput,
  createProtocolTransport,
  type FinalizeInput,
  type FinalizeResult,
  type ProtocolTransport,
  ProtocolTransportError,
  type StageInput,
  type SyncInput,
} from "./sync/transport";
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
