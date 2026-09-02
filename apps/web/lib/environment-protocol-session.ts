import {
  createVerifiedEnvironmentSession,
  type ProtocolTransport,
  type PublicationContext,
  type SyncPageWire,
} from "@dotrelay/client";
import type { EnvironmentVariable } from "./environment-workflow";

export type EnvironmentProtocolSession = Readonly<{
  readonly context: PublicationContext;
  readonly transport: ProtocolTransport;
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
}): EnvironmentProtocolSession => {
  const session = createVerifiedEnvironmentSession(input);
  return Object.freeze({
    context: input.context,
    transport: input.transport,
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
