import type { SyncPageWire } from "@dotrelay/contracts";
import {
  type DecodedVariable,
  decodeSyncVariables,
  type PublicationContext,
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
   * that Revision; Values this Device cannot read stay null.
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
  readonly signingTrustKeys?: readonly Uint8Array[];
}): VerifiedEnvironmentSession => {
  const revisionSigningPublicKey =
    input.signingTrustKeys && input.signingTrustKeys.length > 0
      ? input.signingTrustKeys
      : input.context.revisionSigningPublicKey;
  if (!revisionSigningPublicKey)
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
    let snapshot = previousVariables;
    for (const revision of page.revisions) {
      snapshot = await decodeSyncVariables(
        { ...page, revisions: [revision] },
        resolvePrivateKey,
        snapshot,
        input.sharedValueSecret,
      );
      snapshots.set(revision.id, snapshot);
    }
    cachedVariables = snapshot;
    return snapshot;
  };

  return Object.freeze({
    context: input.context,
    transport: input.transport,
    decodeVariables,
    syncAndDecode: async (request) => {
      const page = await input.transport.syncAll(request);
      await verifySyncPage(page, revisionSigningPublicKey, {
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
