// Device display metadata: a human-readable name plus the client kind, OS,
// and client summary shown beside it. Plain JSON, never inside the signed
// Device certificate. The service stores it cleartext so every Device of
// the User can label peers (Devices table, recovery target picker), and the
// owning Device may rename or refresh it.

import { ContractError } from "./errors";

export const DEVICE_NAME_MAX_LENGTH = 64;
export const DEVICE_OS_NAME_MAX_LENGTH = 32;
export const DEVICE_CLIENT_SUMMARY_MAX_LENGTH = 64;

export type DeviceClientKind = "cli" | "browser";

export type DeviceClientInfo = Readonly<{
  readonly displayName: string;
  readonly clientKind: DeviceClientKind;
  readonly osName: string | null;
  readonly clientSummary: string | null;
}>;

// Control characters never belong in a display label; collapse internal
// whitespace so a hostname or UA fragment cannot smuggle a multi-line spoof.
const isControlCode = (code: number): boolean => code < 0x20 || code === 0x7f;
const INTERNAL_SPACE = /\s+/g;

const sanitizeDisplayText = (value: string, maxLength: number): string => {
  let replaced = "";
  for (const char of value)
    replaced += isControlCode(char.codePointAt(0) ?? 0) ? " " : char;
  return replaced.replace(INTERNAL_SPACE, " ").trim().slice(0, maxLength);
};

export const sanitizeDeviceName = (value: string): string | null => {
  const name = sanitizeDisplayText(value, DEVICE_NAME_MAX_LENGTH);
  return name.length > 0 ? name : null;
};

export const sanitizeDeviceOsName = (value: string): string | null => {
  const name = sanitizeDisplayText(value, DEVICE_OS_NAME_MAX_LENGTH);
  return name.length > 0 ? name : null;
};

export const sanitizeDeviceClientSummary = (value: string): string | null => {
  const name = sanitizeDisplayText(value, DEVICE_CLIENT_SUMMARY_MAX_LENGTH);
  return name.length > 0 ? name : null;
};

const parseOptionalText = (
  value: unknown,
  sanitize: (input: string) => string | null,
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ContractError("invalid_request");
  return sanitize(value);
};

// Parses a `client` object from a bootstrap, enrollment-complete, or
// self-describe body. Throws ContractError on a present-but-invalid field;
// an absent object yields null so callers can treat metadata as optional.
export const parseDeviceClientInfo = (
  value: unknown,
): DeviceClientInfo | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new ContractError("invalid_request");
  const object = value as Record<string, unknown>;
  const clientKind = object.clientKind;
  if (clientKind !== "cli" && clientKind !== "browser")
    throw new ContractError("invalid_request");
  const displayName = parseOptionalText(object.displayName, sanitizeDeviceName);
  if (!displayName) throw new ContractError("invalid_request");
  return Object.freeze({
    displayName,
    clientKind,
    osName: parseOptionalText(object.osName, sanitizeDeviceOsName),
    clientSummary: parseOptionalText(
      object.clientSummary,
      sanitizeDeviceClientSummary,
    ),
  });
};

// Serializes a client-side description for a `client` body field.
export const deviceClientInfoPayload = (
  info: DeviceClientInfo,
): Record<string, unknown> => ({
  displayName: info.displayName,
  clientKind: info.clientKind,
  ...(info.osName ? { osName: info.osName } : {}),
  ...(info.clientSummary ? { clientSummary: info.clientSummary } : {}),
});
