import {
  createVerifiedEnvironmentSession,
  type ProtocolTransport,
  type PublicationContext,
  type RevisionSigningTrust,
  type SyncPageWire,
} from "@dotrelay/client";
import type { EnvironmentVariable } from "./environment-workflow";

export type EnvironmentProtocolSession = Readonly<{
  readonly context: PublicationContext;
  readonly transport: ProtocolTransport;
  readonly signingTrustKeys: RevisionSigningTrust;
  readonly decodeVariables: (
    page: SyncPageWire,
    previousVariables: readonly EnvironmentVariable[],
  ) => Promise<readonly EnvironmentVariable[]>;
  readonly resolveRollbackValues: (input: {
    readonly targetRevision: string;
    readonly selectedVariableIds: readonly string[];
  }) => Promise<ReadonlyMap<string, string | null>>;
}>;

export const createEnvironmentProtocolSession = (input: {
  readonly context: PublicationContext;
  readonly transport: ProtocolTransport;
  readonly sharedValuePrivateKey: CryptoKey;
  readonly userDefinedValuePrivateKey?: CryptoKey;
  readonly signingTrustKeys?: RevisionSigningTrust;
  readonly sharedValueSecret?: Uint8Array;
  readonly userDefinedValueSecret?: Uint8Array;
}): EnvironmentProtocolSession => {
  const signingTrustKeys =
    input.signingTrustKeys && input.signingTrustKeys.length > 0
      ? input.signingTrustKeys
      : input.context.revisionSigningPublicKey
        ? [input.context.revisionSigningPublicKey]
        : [];
  // Reading and publishing must use the same content keys. The workspace
  // resolves the Project epoch key after it builds the publication context
  // and passes that key beside the context; a publish that omits it seals
  // Shared Values to this browser Device, which no other Device can open.
  const context: PublicationContext = {
    ...input.context,
    ...(input.sharedValueSecret
      ? { sharedValueSecret: input.sharedValueSecret }
      : {}),
    ...(input.userDefinedValueSecret
      ? { userDefinedValueSecret: input.userDefinedValueSecret }
      : {}),
  };
  const session = createVerifiedEnvironmentSession({
    ...input,
    context,
    ...(signingTrustKeys.length > 0 ? { signingTrustKeys } : {}),
  });
  return Object.freeze({
    context,
    transport: input.transport,
    signingTrustKeys,
    decodeVariables: async (page, previousVariables) => {
      const decoded = await session.decodeVariables(
        page,
        previousVariables.map((variable) => ({
          ...variable,
          tombstone: variable.tombstone === true,
        })),
      );
      return Object.freeze(
        decoded.map((variable) =>
          Object.freeze({ ...variable, hasDraftChange: false }),
        ),
      );
    },
    resolveRollbackValues: session.resolveRollbackValues,
  });
};
