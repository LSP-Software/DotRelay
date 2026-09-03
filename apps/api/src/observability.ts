import { PROBLEM_STATUS, type ProblemCode } from "@dotrelay/contracts";
import type { DatabaseClient } from "@dotrelay/database";
import {
  SECURITY_REQUEST_ENDPOINT_TEMPLATES,
  SECURITY_REQUEST_LOG_RETENTION_MS,
  type SecurityRequestEndpointTemplate,
  SecurityRequestLogRepository,
} from "@dotrelay/database";

export const API_CORRELATION_HEADER = "X-Correlation-ID";
export const DIAGNOSTIC_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_ENTRIES = 10_000;
const DEFAULT_DIAGNOSTIC_SAMPLE_RATE = 0.1;

export const SERVER_DIAGNOSTIC_EVENT_NAMES = Object.freeze([
  "api.request.completed",
] as const);
export type ServerDiagnosticEventName =
  (typeof SERVER_DIAGNOSTIC_EVENT_NAMES)[number];
const FORBIDDEN_PROBLEM_CODES = [
  "invalid_crypto_object",
  "unsupported_crypto_suite",
  "unsupported_crypto_runtime",
  "crypto_provider_unavailable",
] as const;
export type ServerDiagnosticProblemCode = Exclude<
  ProblemCode,
  (typeof FORBIDDEN_PROBLEM_CODES)[number]
>;
export const SERVER_DIAGNOSTIC_FIELDS = Object.freeze([
  "schemaVersion",
  "eventName",
  "correlationId",
  "durationMs",
  "outcome",
  "problemCode",
  "retryAfterSeconds",
] as const);
export type ServerDiagnosticField = (typeof SERVER_DIAGNOSTIC_FIELDS)[number];

declare const serverCorrelationIdBrand: unique symbol;
export type ServerCorrelationId = string & {
  readonly [serverCorrelationIdBrand]: "ServerCorrelationId";
};

export type ServerDiagnosticEvent = Readonly<{
  readonly schemaVersion: 1;
  readonly eventName: ServerDiagnosticEventName;
  readonly correlationId: ServerCorrelationId;
  readonly durationMs?: number;
  readonly outcome?: "success" | "failure";
  readonly problemCode?: ServerDiagnosticProblemCode;
  readonly retryAfterSeconds?: number;
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
    readonly correlationId: ServerCorrelationId;
    readonly durationMs: number;
  }) => void;
}>;

const safeToken = /^[A-Za-z0-9._:-]+$/;
const forbiddenProblemCodes = new Set<string>(FORBIDDEN_PROBLEM_CODES);
const serverDiagnosticEventNames = new Set<string>(
  SERVER_DIAGNOSTIC_EVENT_NAMES,
);
const serverDiagnosticFields = new Set<string>(SERVER_DIAGNOSTIC_FIELDS);
const SERVER_DIAGNOSTIC_OUTCOMES = new Set(["success", "failure"]);
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ISSUED_CORRELATION_IDS = 100_000;
const issuedCorrelationIds = new Set<string>();

const createCorrelationId = (): ServerCorrelationId => {
  let correlationId = "";
  while (
    correlationId.length === 0 ||
    issuedCorrelationIds.has(correlationId)
  ) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] ?? 0) & 0x0f;
    bytes[6] = (bytes[6] ?? 0) | 0x40;
    bytes[8] = (bytes[8] ?? 0) & 0x3f;
    bytes[8] = (bytes[8] ?? 0) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    correlationId = `${hex.slice(0, 4).join("")}-${hex
      .slice(4, 6)
      .join("")}-${hex.slice(6, 8).join("")}-${hex
      .slice(8, 10)
      .join("")}-${hex.slice(10).join("")}`;
  }
  issuedCorrelationIds.add(correlationId);
  if (issuedCorrelationIds.size > MAX_ISSUED_CORRELATION_IDS) {
    const oldest = issuedCorrelationIds.values().next().value;
    if (typeof oldest === "string") issuedCorrelationIds.delete(oldest);
  }
  return correlationId as ServerCorrelationId;
};

export const createServerCorrelationId = createCorrelationId;

export const createInMemoryDiagnosticSink = (
  now: () => number = Date.now,
): MemoryDiagnosticSink => {
  type DiagnosticEntry = {
    readonly event: ServerDiagnosticEvent;
    readonly expiresAt: number;
    timer?: ReturnType<typeof setTimeout>;
  };
  const entries: DiagnosticEntry[] = [];
  const purge = (at = now()) => {
    const retained = entries.filter((entry) => entry.expiresAt > at);
    for (const entry of entries) {
      if (entry.expiresAt <= at && entry.timer) clearTimeout(entry.timer);
    }
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
      const entry: DiagnosticEntry = {
        event: sanitized,
        expiresAt: now() + DIAGNOSTIC_RETENTION_MS,
      };
      entry.timer = setTimeout(() => purge(), DIAGNOSTIC_RETENTION_MS);
      if (typeof entry.timer === "object" && "unref" in entry.timer)
        entry.timer.unref();
      entries.push(entry);
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

export const endpointTemplateFor = (
  path: string,
): SecurityRequestEndpointTemplate | null =>
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
  if (Object.keys(object).some((key) => !serverDiagnosticFields.has(key)))
    return null;
  if (
    object.schemaVersion !== 1 ||
    typeof object.eventName !== "string" ||
    !serverDiagnosticEventNames.has(object.eventName) ||
    typeof object.correlationId !== "string" ||
    !CORRELATION_ID_PATTERN.test(object.correlationId) ||
    !issuedCorrelationIds.has(object.correlationId)
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
  if (
    object.retryAfterSeconds !== undefined &&
    (typeof object.retryAfterSeconds !== "number" ||
      !Number.isInteger(object.retryAfterSeconds) ||
      object.retryAfterSeconds < 0 ||
      object.retryAfterSeconds > 86_400)
  )
    return null;
  return Object.freeze({
    schemaVersion: 1,
    eventName: object.eventName,
    correlationId: object.correlationId as ServerCorrelationId,
    ...(object.durationMs === undefined
      ? {}
      : { durationMs: object.durationMs }),
    ...(object.outcome === undefined ? {} : { outcome: object.outcome }),
    ...(object.problemCode === undefined
      ? {}
      : { problemCode: object.problemCode }),
    ...(object.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: object.retryAfterSeconds }),
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
