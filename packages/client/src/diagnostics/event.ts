export const DIAGNOSTIC_FIELD_ALLOWLIST = Object.freeze([
  "eventName",
  "correlationId",
  "durationMs",
  "outcome",
  "problemCode",
  "retryAfterSeconds",
]);

export type DiagnosticFieldName = (typeof DIAGNOSTIC_FIELD_ALLOWLIST)[number];

export type DiagnosticEvent = Readonly<
  Record<DiagnosticFieldName, string | number | undefined>
>;

export class DiagnosticBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticBoundaryError";
  }
}

export const createDiagnosticEvent = (
  input: DiagnosticEvent,
): DiagnosticEvent => {
  const output: Record<string, string | number | undefined> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!DIAGNOSTIC_FIELD_ALLOWLIST.includes(key as DiagnosticFieldName))
      throw new DiagnosticBoundaryError(
        `diagnostic field ${key} is not allowlisted`,
      );
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number")
      throw new DiagnosticBoundaryError(
        `diagnostic field ${key} has invalid type`,
      );
    output[key] = value;
  }
  if (typeof output.eventName !== "string")
    throw new DiagnosticBoundaryError("diagnostic event name is required");
  return Object.freeze(output as DiagnosticEvent);
};

export const serializeDiagnosticEvent = (event: DiagnosticEvent): string => {
  const payload: Record<string, string | number> = {};
  for (const field of DIAGNOSTIC_FIELD_ALLOWLIST) {
    const value = event[field];
    if (value !== undefined) payload[field] = value;
  }
  return JSON.stringify(payload);
};

export type RevealBoundary = "never" | "explicit_user_action" | "local_preview";

export const assertRevealBoundary = (
  boundary: RevealBoundary,
  requested: RevealBoundary,
): void => {
  if (boundary === "never" || requested !== boundary)
    throw new DiagnosticBoundaryError("reveal boundary violation");
};
