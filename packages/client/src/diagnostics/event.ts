import { PROBLEM_STATUS } from "@dotrelay/contracts";

export const DIAGNOSTIC_FIELD_ALLOWLIST = Object.freeze([
  "eventName",
  "correlationId",
  "durationMs",
  "outcome",
  "problemCode",
  "retryAfterSeconds",
] as const);

export type DiagnosticFieldName = (typeof DIAGNOSTIC_FIELD_ALLOWLIST)[number];
export type CorrelationId = string & {
  readonly __dotrelayCorrelationId: unique symbol;
};

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const OPTIONAL_TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_DIAGNOSTIC_ENTRIES = 10_000;
export const DIAGNOSTIC_EVENT_NAMES = Object.freeze([
  "client.storage.load",
  "client.storage.save",
  "client.sync",
  "client.test",
  "client.sync.failed",
  "client.crash.reported",
] as const);
const DIAGNOSTIC_OUTCOMES = new Set([
  "success",
  "failure",
  "rejected",
  "denied",
  "cancelled",
]);

export type DiagnosticEvent = Readonly<{
  readonly eventName: string;
  readonly correlationId?: CorrelationId;
  readonly durationMs?: number;
  readonly outcome?: string;
  readonly problemCode?: string;
  readonly retryAfterSeconds?: number;
}>;

export type DiagnosticEventInput = DiagnosticEvent;

export class DiagnosticBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticBoundaryError";
  }
}

const MAX_EVENT_NAME_LENGTH = 128;
const MAX_STRING_FIELD_LENGTH = 64;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_DIAGNOSTIC_PROBLEM_CODES = new Set([
  "invalid_crypto_object",
  "unsupported_crypto_suite",
  "unsupported_crypto_runtime",
  "crypto_provider_unavailable",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOnlyFields = (
  value: Record<string, unknown>,
  fields: readonly string[],
) => {
  const allowed = new Set(fields);
  return Object.keys(value).every((field) => allowed.has(field));
};

const validateStringField = (
  field: DiagnosticFieldName,
  value: string,
  maximum: number,
) => {
  if (value.length === 0 || value.length > maximum)
    throw new DiagnosticBoundaryError(
      `diagnostic field ${field} exceeds its bound`,
    );
  if (!SAFE_TOKEN.test(value))
    throw new DiagnosticBoundaryError(
      `diagnostic field ${field} contains unsafe characters`,
    );
};

const validateNumberField = (
  field: DiagnosticFieldName,
  value: number,
  maximum: number,
) => {
  if (!Number.isInteger(value) || value < 0 || value > maximum)
    throw new DiagnosticBoundaryError(
      `diagnostic field ${field} is outside its bound`,
    );
};

export const createDiagnosticEvent = (
  input: DiagnosticEventInput,
): DiagnosticEvent => {
  if (!isRecord(input))
    throw new DiagnosticBoundaryError("diagnostic event must be an object");
  const output: Record<string, string | number | undefined> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!DIAGNOSTIC_FIELD_ALLOWLIST.includes(key as DiagnosticFieldName))
      throw new DiagnosticBoundaryError(
        `diagnostic field ${key} is not allowlisted`,
      );
    const field = key as DiagnosticFieldName;
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number")
      throw new DiagnosticBoundaryError(
        `diagnostic field ${key} has invalid type`,
      );
    if (typeof value === "string") {
      if (field === "eventName") {
        validateStringField(field, value, MAX_EVENT_NAME_LENGTH);
        if (!DIAGNOSTIC_EVENT_NAMES.includes(value as never))
          throw new DiagnosticBoundaryError(
            "diagnostic event name is not recognized",
          );
      } else {
        validateStringField(field, value, MAX_STRING_FIELD_LENGTH);
        if (field === "correlationId" && !CORRELATION_ID_PATTERN.test(value))
          throw new DiagnosticBoundaryError(
            "diagnostic Correlation ID is invalid",
          );
        if (field === "outcome" && !DIAGNOSTIC_OUTCOMES.has(value))
          throw new DiagnosticBoundaryError(
            "diagnostic outcome is not recognized",
          );
        if (
          field === "problemCode" &&
          (!Object.hasOwn(PROBLEM_STATUS, value) ||
            FORBIDDEN_DIAGNOSTIC_PROBLEM_CODES.has(value))
        )
          throw new DiagnosticBoundaryError(
            "diagnostic problem code is not recognized",
          );
      }
    } else if (field === "durationMs")
      validateNumberField(field, value, MAX_DURATION_MS);
    else if (field === "retryAfterSeconds")
      validateNumberField(field, value, MAX_RETRY_AFTER_SECONDS);
    output[key] = value;
  }
  if (
    typeof output.eventName !== "string" ||
    !SAFE_TOKEN.test(output.eventName)
  )
    throw new DiagnosticBoundaryError("diagnostic event name is required");
  return Object.freeze(output as DiagnosticEvent);
};

export const redactDiagnosticEvent = (
  input: unknown,
): DiagnosticEvent | null => {
  if (!isRecord(input)) return null;
  try {
    const allowlisted = Object.fromEntries(
      Object.entries(input).filter(([key]) =>
        DIAGNOSTIC_FIELD_ALLOWLIST.includes(key as DiagnosticFieldName),
      ),
    ) as DiagnosticEventInput;
    return createDiagnosticEvent(allowlisted);
  } catch {
    return null;
  }
};

export const serializeDiagnosticEvent = (event: DiagnosticEvent): string => {
  const validated = createDiagnosticEvent(event);
  const payload: Record<string, string | number> = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
  };
  for (const field of DIAGNOSTIC_FIELD_ALLOWLIST) {
    const value = validated[field];
    if (value !== undefined) payload[field] = value;
  }
  return JSON.stringify(payload);
};

export const createCorrelationId = (): CorrelationId => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] ?? 0) & 0x0f;
  bytes[6] = (bytes[6] ?? 0) | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f;
  bytes[8] = (bytes[8] ?? 0) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join(
      "",
    )}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}` as CorrelationId;
};

export type DiagnosticSink = Readonly<{
  readonly emit: (event: DiagnosticEvent) => void;
  readonly records: (now?: number) => readonly string[];
  readonly purge: (now?: number) => number;
}>;

export const createInMemoryDiagnosticSink = (options?: {
  readonly sampleRate?: number;
  readonly now?: () => number;
  readonly random?: () => number;
}): DiagnosticSink => {
  const sampleRate = options?.sampleRate ?? 1;
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1)
    throw new DiagnosticBoundaryError("diagnostic sample rate is invalid");
  const now = options?.now ?? Date.now;
  const random = options?.random ?? Math.random;
  const entries: Array<{ readonly expiresAt: number; readonly value: string }> =
    [];
  const purge = (at = now()) => {
    const retained = entries.filter((entry) => entry.expiresAt > at);
    const removed = entries.length - retained.length;
    entries.splice(0, entries.length, ...retained);
    return removed;
  };
  return Object.freeze({
    emit: (event: DiagnosticEvent) => {
      purge();
      if (random() >= sampleRate) return;
      try {
        const value = serializeDiagnosticEvent(event);
        if (entries.length >= MAX_DIAGNOSTIC_ENTRIES) entries.shift();
        entries.push({
          expiresAt: now() + DIAGNOSTIC_RETENTION_MS,
          value,
        });
      } catch {
        // Diagnostic loss is intentionally non-blocking.
      }
    },
    records: (at?: number) => {
      purge(at);
      return Object.freeze(entries.map((entry) => entry.value));
    },
    purge,
  });
};

export const SAFE_METRIC_DIMENSIONS = Object.freeze([
  "eventName",
  "outcome",
  "problemCode",
] as const);

export type SafeMetricDimensions = Readonly<{
  readonly eventName: string;
  readonly outcome?: string;
  readonly problemCode?: string;
}>;

export const metricDimensionsFromEvent = (
  event: DiagnosticEvent,
): SafeMetricDimensions => {
  const validated = createDiagnosticEvent(event);
  return Object.freeze({
    eventName: validated.eventName,
    ...(validated.outcome === undefined ? {} : { outcome: validated.outcome }),
    ...(validated.problemCode === undefined
      ? {}
      : { problemCode: validated.problemCode }),
  });
};

export type PrivateDiagnosticTrace = Readonly<{
  readonly schemaVersion: 1;
  readonly traceName: string;
  readonly correlationId: CorrelationId;
  readonly durationMs: number;
  readonly outcome?: string;
  readonly expiresAt: number;
}>;

export const createPrivateTrace = (
  input: {
    readonly enabled: boolean;
    readonly traceName: string;
    readonly correlationId: CorrelationId;
    readonly durationMs: number;
    readonly outcome?: string;
  },
  now = Date.now(),
): PrivateDiagnosticTrace | null => {
  if (!input.enabled) return null;
  if (!CORRELATION_ID_PATTERN.test(input.correlationId))
    throw new DiagnosticBoundaryError(
      "private trace Correlation ID is invalid",
    );
  const event = createDiagnosticEvent({
    eventName: input.traceName,
    correlationId: input.correlationId,
    durationMs: input.durationMs,
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
  });
  return Object.freeze({
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    traceName: event.eventName,
    correlationId: event.correlationId as CorrelationId,
    durationMs: event.durationMs as number,
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
    expiresAt: now + OPTIONAL_TRACE_RETENTION_MS,
  });
};

export type ExplicitCrashReport = Readonly<{
  readonly schemaVersion: 1;
  readonly eventName: "client.crash.reported";
  readonly correlationId: CorrelationId;
  readonly problemCode: string;
  readonly expiresAt: number;
}>;

export const createExplicitCrashReport = (
  input: {
    readonly correlationId: CorrelationId;
    readonly problemCode: string;
  },
  now = Date.now(),
): ExplicitCrashReport => {
  if (!CORRELATION_ID_PATTERN.test(input.correlationId))
    throw new DiagnosticBoundaryError("crash report Correlation ID is invalid");
  const event = createDiagnosticEvent({
    eventName: "client.crash.reported",
    correlationId: input.correlationId,
    problemCode: input.problemCode,
  });
  return Object.freeze({
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    eventName: "client.crash.reported",
    correlationId: event.correlationId as CorrelationId,
    problemCode: event.problemCode as string,
    expiresAt: now + OPTIONAL_TRACE_RETENTION_MS,
  });
};

export type LocalDiagnosticStore = Readonly<{
  readonly addTrace: (trace: PrivateDiagnosticTrace) => void;
  readonly addCrashReport: (report: ExplicitCrashReport) => void;
  readonly traces: (now?: number) => readonly PrivateDiagnosticTrace[];
  readonly crashReports: (now?: number) => readonly ExplicitCrashReport[];
  readonly purge: (now?: number) => number;
}>;

export const createLocalDiagnosticStore = (
  now: () => number = Date.now,
): LocalDiagnosticStore => {
  const traces: PrivateDiagnosticTrace[] = [];
  const crashReports: ExplicitCrashReport[] = [];
  const purge = (at = now()) => {
    const traceCount = traces.length;
    const crashCount = crashReports.length;
    traces.splice(
      0,
      traces.length,
      ...traces.filter((trace) => trace.expiresAt > at),
    );
    crashReports.splice(
      0,
      crashReports.length,
      ...crashReports.filter((report) => report.expiresAt > at),
    );
    return traceCount - traces.length + crashCount - crashReports.length;
  };
  const sanitizeTrace = (value: unknown, at: number) => {
    if (
      !isRecord(value) ||
      !hasOnlyFields(value, [
        "schemaVersion",
        "traceName",
        "correlationId",
        "durationMs",
        "outcome",
        "expiresAt",
      ]) ||
      value.schemaVersion !== 1 ||
      typeof value.traceName !== "string" ||
      typeof value.correlationId !== "string" ||
      typeof value.durationMs !== "number" ||
      (value.outcome !== undefined && typeof value.outcome !== "string") ||
      typeof value.expiresAt !== "number" ||
      !Number.isInteger(value.expiresAt) ||
      value.expiresAt <= at ||
      value.expiresAt > at + OPTIONAL_TRACE_RETENTION_MS
    )
      return null;
    try {
      const event = createDiagnosticEvent({
        eventName: value.traceName,
        correlationId: value.correlationId as CorrelationId,
        durationMs: value.durationMs,
        ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
      });
      return Object.freeze({
        schemaVersion: 1,
        traceName: event.eventName,
        correlationId: event.correlationId as CorrelationId,
        durationMs: event.durationMs as number,
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
        expiresAt: value.expiresAt,
      });
    } catch {
      return null;
    }
  };
  const sanitizeCrashReport = (value: unknown, at: number) => {
    if (
      !isRecord(value) ||
      !hasOnlyFields(value, [
        "schemaVersion",
        "eventName",
        "correlationId",
        "problemCode",
        "expiresAt",
      ]) ||
      value.schemaVersion !== 1 ||
      value.eventName !== "client.crash.reported" ||
      typeof value.correlationId !== "string" ||
      typeof value.problemCode !== "string" ||
      typeof value.expiresAt !== "number" ||
      !Number.isInteger(value.expiresAt) ||
      value.expiresAt <= at ||
      value.expiresAt > at + OPTIONAL_TRACE_RETENTION_MS
    )
      return null;
    try {
      const report = createExplicitCrashReport({
        correlationId: value.correlationId as CorrelationId,
        problemCode: value.problemCode,
      });
      return Object.freeze({ ...report, expiresAt: value.expiresAt });
    } catch {
      return null;
    }
  };
  return Object.freeze({
    addTrace: (trace: PrivateDiagnosticTrace) => {
      const at = now();
      purge(at);
      const sanitized = sanitizeTrace(trace, at);
      if (!sanitized) return;
      if (traces.length >= MAX_DIAGNOSTIC_ENTRIES) traces.shift();
      traces.push(sanitized);
    },
    addCrashReport: (report: ExplicitCrashReport) => {
      const at = now();
      purge(at);
      const sanitized = sanitizeCrashReport(report, at);
      if (!sanitized) return;
      if (crashReports.length >= MAX_DIAGNOSTIC_ENTRIES) crashReports.shift();
      crashReports.push(sanitized);
    },
    traces: (at?: number) => {
      purge(at);
      return Object.freeze([...traces]);
    },
    crashReports: (at?: number) => {
      purge(at);
      return Object.freeze([...crashReports]);
    },
    purge,
  });
};

export type RevealBoundary = "never" | "explicit_user_action" | "local_preview";

export const assertRevealBoundary = (
  boundary: RevealBoundary,
  requested: RevealBoundary,
): void => {
  if (boundary === "never" || requested !== boundary)
    throw new DiagnosticBoundaryError("reveal boundary violation");
};
