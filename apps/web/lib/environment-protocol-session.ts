import {
  createVerifiedEnvironmentSession,
  type ProtocolTransport,
  type PublicationContext,
  type RevisionSigningTrust,
  type RevisionSigningTrustEntry,
  revisionAuthoredAtNotBeforeMs,
  type SharedValueKeyRing,
  type SyncPageWire,
} from "@dotrelay/client";
import { hexToBytes } from "./account-keys";
import type { EnvironmentVariable } from "./environment-workflow";
import type { WorkspaceSigningTrustDevice } from "./workspace-boundary";

/**
 * The boundary's signing trust devices as the entries Revision verification
 * judges authors against. Every Membership period is forwarded (ADR 0016):
 * without it a Member who was removed and invited back could not verify
 * their own earlier Revisions. Entries with a malformed key are skipped.
 */
export const revisionSigningTrustEntries = (
  devices: readonly WorkspaceSigningTrustDevice[],
): RevisionSigningTrustEntry[] =>
  devices.flatMap((device): RevisionSigningTrustEntry[] => {
    let publicKey: Uint8Array;
    try {
      publicKey = hexToBytes(device.signingPublicKey);
    } catch {
      return [];
    }
    return [
      {
        publicKey,
        ...(device.deviceId ? { deviceId: device.deviceId } : {}),
        ...(device.userId ? { userId: device.userId } : {}),
        deviceActiveFromMs: device.deviceActiveFromMs,
        deviceActiveUntilMs: device.deviceActiveUntilMs,
        memberSinceMs: device.memberSinceMs,
        memberUntilMs: device.memberUntilMs,
        ...(device.membershipPeriods
          ? { membershipPeriods: device.membershipPeriods }
          : {}),
      },
    ];
  });

/**
 * The part of a new Revision's authored-at floor this Device knows from the
 * boundary: its own activation and its author's current Membership
 * activation. The editor raises it to the head Revision's authored-at
 * instant at publish time (see publicationAuthoredAtNotBeforeMs).
 */
export const deviceAuthoredAtNotBeforeMs = (
  devices: readonly WorkspaceSigningTrustDevice[],
  deviceId: string,
): number | undefined => {
  const own = devices.find((device) => device.deviceId === deviceId);
  return own
    ? revisionAuthoredAtNotBeforeMs({
        deviceActiveFromMs: own.deviceActiveFromMs,
        memberSinceMs: own.memberSinceMs,
      })
    : undefined;
};

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
  // Keys of earlier Project epochs, so content sealed before a rotation
  // stays readable; publications always use sharedValueSecret.
  readonly sharedValueKeyRing?: SharedValueKeyRing;
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
