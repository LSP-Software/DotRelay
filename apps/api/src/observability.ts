import { PROBLEM_STATUS } from "@dotrelay/contracts";
import type { DatabaseClient } from "@dotrelay/database";
import {
  SECURITY_REQUEST_ENDPOINT_TEMPLATES,
  SECURITY_REQUEST_LOG_RETENTION_MS,
  SecurityRequestLogRepository,
} from "@dotrelay/database";

export const API_CORRELATION_HEADER = "X-Correlation-ID";
export const DIAGNOSTIC_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_ENTRIES = 10_000;
const DEFAULT_DIAGNOSTIC_SAMPLE_RATE = 0.1;

export type ServerDiagnosticEvent = Readonly<{
  readonly schemaVersion: 1;
  readonly eventName: string;
  readonly correlationId: string;
  readonly durationMs?: number;
  readonly outcome?: "success" | "failure";
  readonly problemCode?: string;
}>;

export type ServerDiagnosticSink = Readonly<{
  readonly emit: (event: ServerDiagnosticEvent) => void;
}>;

export type MemoryDiagnosticSink = ServerDiagnosticSink &
  Readonly<{
    readonly records: (now?: number) => readonly ServerDiagnosticEvent[];
    readonly purge: (now?: number) => number;
  }>;

export type ApiObservability = Readonly<{
  readonly diagnostics: ServerDiagnosticSink;
  readonly expireSecurityRequestLogs: (at?: Date) => Promise<number>;
  readonly recordRequest: (input: {
    readonly request: Request;
    readonly path: string;
    readonly status: number;
    readonly correlationId: string;
    readonly durationMs: number;
  }) => void;
}>;

const safeToken = /^[A-Za-z0-9._:-]+$/;
const forbiddenProblemCodes = new Set([
  "invalid_crypto_object",
  "unsupported_crypto_suite",
  "unsupported_crypto_runtime",
  "crypto_provider_unavailable",
]);
const SERVER_DIAGNOSTIC_EVENT_NAMES = new Set(["api.request.completed"]);
const SERVER_DIAGNOSTIC_OUTCOMES = new Set(["success", "failure"]);
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const createCorrelationId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] ?? 0) & 0x0f;
  bytes[6] = (bytes[6] ?? 0) | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f;
  bytes[8] = (bytes[8] ?? 0) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
};

export const createServerCorrelationId = createCorrelationId;

export const createInMemoryDiagnosticSink = (
  now: () => number = Date.now,
): MemoryDiagnosticSink => {
  const entries: Array<{
    readonly event: ServerDiagnosticEvent;
    readonly expiresAt: number;
  }> = [];
  const purge = (at = now()) => {
    const retained = entries.filter((entry) => entry.expiresAt > at);
    const removed = entries.length - retained.length;
    entries.splice(0, entries.length, ...retained);
    return removed;
  };
  return Object.freeze({
    emit: (event: ServerDiagnosticEvent) => {
      const sanitized = sanitizeServerDiagnosticEvent(event);
      if (!sanitized) return;
      purge();
      if (entries.length >= MAX_DIAGNOSTIC_ENTRIES) entries.shift();
      entries.push({
        event: sanitized,
        expiresAt: now() + DIAGNOSTIC_RETENTION_MS,
      });
    },
    records: (at?: number) => {
      purge(at);
      return Object.freeze(entries.map((entry) => entry.event));
    },
    purge,
  });
};

const endpointPattern = (template: string): RegExp =>
  new RegExp(
    `^${template
      .split("/")
      .map((segment) =>
        segment === "*"
          ? ".*"
          : segment.startsWith(":")
            ? "[^/]+"
            : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/")}$`,
  );

const ENDPOINT_PATTERNS = SECURITY_REQUEST_ENDPOINT_TEMPLATES.map((template) =>
  Object.freeze({ template, pattern: endpointPattern(template) }),
);

export const endpointTemplateFor = (path: string): string | null =>
  ENDPOINT_PATTERNS.find(({ pattern }) => pattern.test(path))?.template ?? null;

const emitSafely = (
  sink: ServerDiagnosticSink,
  event: ServerDiagnosticEvent,
) => {
  try {
    const sanitized = sanitizeServerDiagnosticEvent(event);
    if (sanitized) sink.emit(sanitized);
  } catch {
    // Losing diagnostics must never affect the request or domain behavior.
  }
};

const sanitizeServerDiagnosticEvent = (
  input: unknown,
): ServerDiagnosticEvent | null => {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return null;
  const object = input as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "eventName",
    "correlationId",
    "durationMs",
    "outcome",
    "problemCode",
  ]);
  if (Object.keys(object).some((key) => !allowed.has(key))) return null;
  if (
    object.schemaVersion !== 1 ||
    typeof object.eventName !== "string" ||
    !SERVER_DIAGNOSTIC_EVENT_NAMES.has(object.eventName) ||
    typeof object.correlationId !== "string" ||
    !CORRELATION_ID_PATTERN.test(object.correlationId)
  )
    return null;
  if (
    object.durationMs !== undefined &&
    (typeof object.durationMs !== "number" ||
      !Number.isInteger(object.durationMs) ||
      object.durationMs < 0 ||
      object.durationMs > 86_400_000)
  )
    return null;
  if (
    object.outcome !== undefined &&
    (typeof object.outcome !== "string" ||
      !SERVER_DIAGNOSTIC_OUTCOMES.has(object.outcome))
  )
    return null;
  if (
    object.problemCode !== undefined &&
    (typeof object.problemCode !== "string" ||
      object.problemCode.length > 64 ||
      !safeToken.test(object.problemCode) ||
      !Object.hasOwn(PROBLEM_STATUS, object.problemCode) ||
      forbiddenProblemCodes.has(object.problemCode))
  )
    return null;
  return Object.freeze({
    schemaVersion: 1,
    eventName: object.eventName,
    correlationId: object.correlationId,
    ...(object.durationMs === undefined
      ? {}
      : { durationMs: object.durationMs }),
    ...(object.outcome === undefined ? {} : { outcome: object.outcome }),
    ...(object.problemCode === undefined
      ? {}
      : { problemCode: object.problemCode }),
  }) as ServerDiagnosticEvent;
};

export const createApiObservability = (
  database: DatabaseClient,
  options?: Readonly<{
    readonly diagnostics?: ServerDiagnosticSink;
    readonly now?: () => Date;
    readonly random?: () => number;
    readonly resolveClientIp?: (request: Request) => string | null;
    readonly sampleRate?: number;
  }>,
): ApiObservability => {
  const diagnostics = options?.diagnostics ?? createInMemoryDiagnosticSink();
  const now = options?.now ?? (() => new Date());
  const random = options?.random ?? Math.random;
  const sampleRate = options?.sampleRate ?? DEFAULT_DIAGNOSTIC_SAMPLE_RATE;
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1)
    throw new Error("diagnostic sample rate is invalid");
  const securityLogs = new SecurityRequestLogRepository();
  return Object.freeze({
    diagnostics,
    expireSecurityRequestLogs: async (at = now()) =>
      (await securityLogs.expire(database, at)).count,
    recordRequest: (input) => {
      try {
        const status = Number.isInteger(input.status) ? input.status : 500;
        if (random() < sampleRate)
          emitSafely(diagnostics, {
            schemaVersion: 1,
            eventName: "api.request.completed",
            correlationId: input.correlationId,
            durationMs: Math.max(
              0,
              Math.min(Math.round(input.durationMs), 86_400_000),
            ),
            outcome: status >= 400 ? "failure" : "success",
          });

        const endpointTemplate = endpointTemplateFor(input.path);
        const ipAddress = options?.resolveClientIp?.(input.request) ?? null;
        if (!endpointTemplate || !ipAddress) return;
        const requestedAt = now();
        const contentLength = input.request.headers.get("Content-Length");
        const transferBytes =
          contentLength && /^\d+$/.test(contentLength)
            ? BigInt(contentLength)
            : 0n;
        void securityLogs
          .append(database, {
            ipAddress,
            endpointTemplate,
            httpStatus: status,
            transferBytes,
            requestedAt,
            expiresAt: new Date(
              requestedAt.getTime() + SECURITY_REQUEST_LOG_RETENTION_MS,
            ),
          })
          .catch(() => {
            // Request logging is a best-effort security signal and never blocks a response.
          });
      } catch {
        // Request logging is a best-effort security signal and never blocks a response.
      }
    },
  });
};
