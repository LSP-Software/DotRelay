import type { SyncPageWire } from "@dotrelay/contracts";
import {
  type DecodedVariable,
  decodeSyncManifest,
  type PublicationContext,
  type RevisionSigningTrust,
  verifySyncPage,
} from "./publication";
import type { ProtocolTransport, SyncInput } from "./transport";

export type VerifiedEnvironmentSession = Readonly<{
  readonly context: PublicationContext;
  readonly transport: ProtocolTransport;
  readonly decodeVariables: (
    page: SyncPageWire,
    previousVariables?: readonly DecodedVariable[],
  ) => Promise<readonly DecodedVariable[]>;
  readonly syncAndDecode: (input: {
    readonly environmentId: string;
    readonly deviceId: string;
    readonly request: SyncInput["request"];
  }) => Promise<
    Readonly<{
      readonly page: SyncPageWire;
      readonly variables: readonly DecodedVariable[];
    }>
  >;
  /**
   * Resolves the Values this Device verified at the target Revision for the
   * requested Variables. A requested Variable that did not exist in that
   * Revision is omitted from the result: the verified history says it was
   * absent, which is not a failure. The call rejects only when the Revision
   * itself is unavailable to this Device (missing from the local verified
   * sync cache) or its data cannot be read.
   */
  readonly resolveRollbackValues: (input: {
    readonly targetRevision: string;
    readonly selectedVariableIds: readonly string[];
  }) => Promise<ReadonlyMap<string, string | null>>;
  /**
   * The decoded Manifest snapshot at each verified Revision of the last
   * sync, keyed by Revision id. Snapshots accumulate from the previous
   * one, so a snapshot is the complete Variable set the Environment held at
   * that Revision; a Value this Device cannot read stays null, never an
   * earlier Value.
   */
  readonly revisionSnapshots: () => ReadonlyMap<
    string,
    readonly DecodedVariable[]
  >;
}>;

export const createVerifiedEnvironmentSession = (input: {
  readonly context: PublicationContext;
  readonly transport: ProtocolTransport;
  readonly sharedValuePrivateKey: CryptoKey;
  readonly userDefinedValuePrivateKey?: CryptoKey;
  readonly sharedValueSecret?: Uint8Array;
  /**
   * The trust set Revision signatures are checked against. Plain keys carry
   * no authorization window; entries name the signing Device and Member and
   * the Device/Membership windows that were valid at the Revision's
   * authored-at instant, so signatures from a Device revoked after a
   * legitimate Revision stay verifiable while later writes stay rejected.
   */
  readonly signingTrustKeys?: RevisionSigningTrust;
}): VerifiedEnvironmentSession => {
  const signingTrust =
    input.signingTrustKeys && input.signingTrustKeys.length > 0
      ? input.signingTrustKeys
      : input.context.revisionSigningPublicKey;
  if (!signingTrust)
    throw new Error("revision signing trust key is required for live sync");
  const snapshots = new Map<string, readonly DecodedVariable[]>();
  let cachedVariables: readonly DecodedVariable[] = [];
  const resolvePrivateKey = (
    scope: "SHARED_VALUE" | "USER_DEFINED_VALUE",
  ): CryptoKey => {
    if (scope === "SHARED_VALUE") return input.sharedValuePrivateKey;
    if (!input.userDefinedValuePrivateKey)
      throw new Error("User-defined Value key grant is unavailable");
    return input.userDefinedValuePrivateKey;
  };

  const decodeVariables = async (
    page: SyncPageWire,
    previousVariables: readonly DecodedVariable[] = cachedVariables,
  ): Promise<readonly DecodedVariable[]> => {
    // The whole verified page decodes as one Manifest fold so a Revision
    // that re-publishes a lane readably clears an earlier unreadable one;
    // a required lane unreadable at the head rejects the sync instead of
    // yielding an empty or stale Manifest.
    const decoded = await decodeSyncManifest(
      page,
      resolvePrivateKey,
      previousVariables,
      input.sharedValueSecret,
      input.context.actorUserId,
    );
    for (const [revisionId, snapshot] of decoded.snapshots)
      snapshots.set(revisionId, snapshot);
    cachedVariables = decoded.variables;
    return decoded.variables;
  };

  return Object.freeze({
    context: input.context,
    transport: input.transport,
    decodeVariables,
    syncAndDecode: async (request) => {
      const page = await input.transport.syncAll(request);
      await verifySyncPage(page, signingTrust, {
        actorUserId: input.context.actorUserId,
      });
      const variables = await decodeVariables(page);
      return Object.freeze({ page, variables });
    },
    resolveRollbackValues: async ({ targetRevision, selectedVariableIds }) => {
      const snapshot = snapshots.get(targetRevision);
      if (!snapshot)
        throw new Error(
          "verified historical Revision is not present in the local sync cache",
        );
      const selected = new Set(selectedVariableIds);
      const values = new Map<string, string | null>();
      for (const variable of snapshot) {
        if (selected.has(variable.id)) values.set(variable.id, variable.value);
      }
      return values;
    },
    revisionSnapshots: () => snapshots,
  });
};
