export type { SyncPageWire } from "@dotrelay/contracts";
export {
  ACCOUNT_KEY_ENVELOPE_KIND,
  ACCOUNT_KEY_TRANSFER_KIND,
  ACCOUNT_KEY_WRAPPER_FORMAT_VERSION,
  ACCOUNT_KEY_WRAPPER_KIND,
  type AccountKeyEnvelope,
  type AccountKeyEnvelopeInput,
  type AccountKeyTransfer,
  type AccountKeyTransferInput,
  type AccountKeyWrapper,
  type AccountKeyWrapperInput,
  createAccountKeyEnvelope,
  createAccountKeyTransfer,
  createAccountKeyWrapper,
  DEFAULT_PASSWORD_KDF,
  decodeRecoveryCode,
  encodeRecoveryCode,
  generateAccountMasterKey,
  generateRecoveryCode,
  KDF_ARGON2ID,
  KEY_ENVELOPE_TYPE,
  type KeyEnvelopeType,
  openAccountKeyEnvelope,
  openAccountKeyTransfer,
  type PasswordKdfParameters,
  parseAccountKeyEnvelope,
  parseAccountKeyTransfer,
  parseAccountKeyWrapper,
  type UnwrapAccountKeyWrapperInput,
  unwrapAccountKeyWrapper,
  WRAPPER_TYPE,
  type WrapperType,
} from "./account";
export type {
  Argon2KdfParams,
  Argon2WorkerReply,
  Argon2WorkerRequest,
} from "./account/argon2-worker";
export {
  authenticatedCreatorKeys,
  deviceHistorySigningKeys,
  openOwnedUserValueKey,
  USER_VALUE_KEY_GENERATION,
} from "./account/user-value-key";
export {
  type AccountKeyTrustedKeys,
  type AccountKeyVerificationContext,
  AccountKeyVerificationError,
  verifyAccountKeyEnvelope,
  verifyAccountKeyTransfer,
  verifyAccountKeyWrapper,
} from "./account/verification";
export {
  createPasskeyWithPrf,
  extractPasskeyPrfOutput,
  type PasskeyCredential,
  PasskeyPrfError,
  type PasskeyPrfErrorCode,
  type PasskeyPrfPlatform,
  type PrfAuthenticationOutput,
  type PrfEvaluationResults,
  type PrfRegistrationOutput,
  passkeyPrfSupported,
  runPasskeyAssertion,
} from "./account/webauthn-prf";
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
  openProjectEpochGrant,
  type ProjectEpochGrantBootstrap,
} from "./device/grant-bootstrap";
export {
  assertRevealBoundary,
  type CorrelationId,
  createCorrelationId,
  createDiagnosticEvent,
  createExplicitCrashReport,
  createInMemoryDiagnosticSink,
  createLocalDiagnosticStore,
  createPrivateTrace,
  DIAGNOSTIC_FIELD_ALLOWLIST,
  DIAGNOSTIC_RETENTION_MS,
  DIAGNOSTIC_SCHEMA_VERSION,
  DiagnosticBoundaryError,
  type DiagnosticEvent,
  type DiagnosticEventName,
  type DiagnosticFieldName,
  type DiagnosticOutcome,
  type DiagnosticProblemCode,
  type DiagnosticSink,
  type ExplicitCrashReport,
  type LocalDiagnosticStore,
  MAX_DIAGNOSTIC_ENTRIES,
  metricDimensionsFromEvent,
  OPTIONAL_TRACE_RETENTION_MS,
  type PrivateDiagnosticTrace,
  type RevealBoundary,
  redactDiagnosticEvent,
  SAFE_METRIC_DIMENSIONS,
  serializeDiagnosticEvent,
} from "./diagnostics/event";
export {
  type BrowserDeviceStorage,
  type BrowserDeviceStorageProbe,
  createBrowserDeviceStorage,
  createIndexedDbDeviceRecordStore,
  createMemoryDeviceRecordStore,
  probeBrowserDeviceStorage,
  resetMemoryDeviceRecordStore,
} from "./storage/browser";
export {
  type CliDeviceStorage,
  createCliDeviceStorage,
  createMemoryCredentialStore,
  resetMemoryCredentialStore,
} from "./storage/cli";
export {
  type BrowserProfilePinStore,
  createBrowserProfilePinStore,
  type ProfilePinRecordStore,
  profilePinKey,
  resetMemoryProfilePinStore,
} from "./storage/profile-pin";
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
  createEpochRotationArtifacts,
  type EpochRotationArtifacts,
  type EpochRotationInput,
} from "./sync/epoch-rotation";
export {
  type ManifestCounts,
  manifestCountsFromDescriptor,
  validateManifestDescriptor,
  validateRevisionManifest,
} from "./sync/manifest";
export {
  assertPublicationAccepted,
  changedVariableIdsFromRevision,
  changedVariableIdsFromSyncPage,
  createPublicationArtifacts,
  type DecodedVariable,
  decodeSyncManifest,
  decodeSyncVariables,
  isRollbackRevision,
  openLane,
  type PublicationArtifacts,
  type PublicationContext,
  type PublicationMutationKind,
  type PublicationReview,
  type PublicationVariable,
  type RevisionSigningTrust,
  type RevisionSigningTrustEntry,
  reviewPublication,
  type StagedPublicationObject,
  type SyncManifestDecode,
  UnreadableLaneError,
  type UnreadableLaneKind,
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
  type EpochRotateInput,
  type EpochRotateResult,
  type EpochRotationTransportRequest,
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
  type InlineValueHunk,
  splitInlineValueDiff,
} from "./values/diff";
export {
  absentUserDefinedValue,
  classifyUserDefinedValue,
  emptyUserDefinedValue,
  isRevealPermitted,
  presentUserDefinedValue,
  type UserDefinedValueState,
} from "./values/state";
