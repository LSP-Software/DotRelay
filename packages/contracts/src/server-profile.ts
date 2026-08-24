import {
  type CapabilitiesDocument,
  isCanonicalOrigin,
  parseCapabilitiesDocument,
} from "./api";
import { assertCryptoRuntime } from "./crypto";

export type ServerProfilePin = Readonly<{
  readonly serverProfileId: string;
  readonly origin: string;
}>;

export type ServerProfileTrustErrorCode =
  | "identity_changed"
  | "origin_mismatch"
  | "rebind_required";

export class ServerProfileTrustError extends Error {
  readonly code: ServerProfileTrustErrorCode;

  constructor(code: ServerProfileTrustErrorCode) {
    super(code);
    this.name = "ServerProfileTrustError";
    this.code = code;
  }
}

const canonicalOrigin = (value: string): string => {
  if (!isCanonicalOrigin(value))
    throw new ServerProfileTrustError("origin_mismatch");
  return value;
};

export const establishServerProfileTrust = async (
  value: unknown,
  options: Readonly<{
    readonly requestedOrigin: string;
    readonly pinned?: ServerProfilePin;
    readonly allowRebind?: boolean;
    readonly runtime?: Crypto;
  }>,
): Promise<
  Readonly<{ capabilities: CapabilitiesDocument; pin: ServerProfilePin }>
> => {
  const capabilities = parseCapabilitiesDocument(value);
  const requestedOrigin = canonicalOrigin(options.requestedOrigin);
  if (capabilities.origin !== requestedOrigin)
    throw new ServerProfileTrustError("origin_mismatch");
  if (
    options.pinned &&
    options.pinned.serverProfileId !== capabilities.serverProfileId
  )
    throw new ServerProfileTrustError("identity_changed");
  if (
    options.pinned &&
    options.pinned.origin !== capabilities.origin &&
    options.allowRebind !== true
  )
    throw new ServerProfileTrustError("rebind_required");
  await assertCryptoRuntime(options.runtime);
  return Object.freeze({
    capabilities,
    pin: Object.freeze({
      serverProfileId: capabilities.serverProfileId,
      origin: capabilities.origin,
    }),
  });
};
