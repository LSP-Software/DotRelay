import { createHash, timingSafeEqual } from "node:crypto";
import type { MetricsConfig } from "./metrics-config";
import {
  SERVER_DIAGNOSTIC_EVENT_NAMES,
  type ServerDiagnosticEvent,
  type ServerMetricsObserver,
  toServerDiagnosticProblemCode,
} from "./observability";

/**
 * Bounded, in-process metrics derived from Application Diagnostic Events.
 * Every label value comes from a fixed allowlist; anything else is counted
 * as "other", so no request value, identifier or address can become a label.
 * See docs/wiki/observability.md#metrics.
 */
export type MetricsRegistry = ServerMetricsObserver &
  Readonly<{
    /** Prometheus text exposition format 0.0.4. */
    readonly render: (
      gauges?: Readonly<{ readonly ready?: boolean }>,
    ) => string;
  }>;

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
const OTHER = "other";
const NONE = "none";
const MAX_SERIES = 512;
const DURATION_BUCKETS_SECONDS = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);
const STATUS_CLASSES = new Set(["1xx", "2xx", "3xx", "4xx", "5xx"]);
const OUTCOMES = new Set(["success", "failure"]);
const eventNames = new Set<string>(SERVER_DIAGNOSTIC_EVENT_NAMES);

export const statusClassFor = (status: number): string => {
  const statusClass = `${Math.trunc(status / 100)}xx`;
  return Number.isInteger(status) && STATUS_CLASSES.has(statusClass)
    ? statusClass
    : OTHER;
};

const eventLabels = (
  event: ServerDiagnosticEvent,
): readonly [string, string, string] => [
  eventNames.has(event.eventName) ? event.eventName : OTHER,
  event.outcome === undefined
    ? NONE
    : OUTCOMES.has(event.outcome)
      ? event.outcome
      : OTHER,
  event.problemCode === undefined
    ? NONE
    : (toServerDiagnosticProblemCode(event.problemCode) ?? OTHER),
];

// Label values are allowlisted tokens; escaping is defence in depth.
const escapeLabel = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const formatLabels = (names: readonly string[], values: readonly string[]) =>
  names.length === 0
    ? ""
    : `{${names
        .map((name, index) => `${name}="${escapeLabel(values[index] ?? "")}"`)
        .join(",")}}`;

const createCounterFamily = (labelNames: readonly string[]) => {
  const series = new Map<string, number>();
  const overflow = labelNames.map(() => OTHER);
  return Object.freeze({
    increment: (values: readonly string[]) => {
      let key = JSON.stringify(values);
      if (!series.has(key) && series.size >= MAX_SERIES)
        key = JSON.stringify(overflow);
      series.set(key, (series.get(key) ?? 0) + 1);
    },
    lines: (name: string) =>
      [...series.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
          ([key, value]) =>
            `${name}${formatLabels(labelNames, JSON.parse(key) as string[])} ${value}`,
        ),
  });
};

const createHistogram = () => {
  const counts = DURATION_BUCKETS_SECONDS.map(() => 0);
  let count = 0;
  let sum = 0;
  return Object.freeze({
    observe: (seconds: number) => {
      count += 1;
      sum += seconds;
      DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
        if (seconds <= bound) counts[index] = (counts[index] ?? 0) + 1;
      });
    },
    lines: (name: string) => [
      ...DURATION_BUCKETS_SECONDS.map(
        (bound, index) => `${name}_bucket{le="${bound}"} ${counts[index] ?? 0}`,
      ),
      `${name}_bucket{le="+Inf"} ${count}`,
      `${name}_sum ${Number(sum.toFixed(6))}`,
      `${name}_count ${count}`,
    ],
  });
};

export const createMetricsRegistry = (): MetricsRegistry => {
  const events = createCounterFamily(["event_name", "outcome", "problem_code"]);
  const requests = createCounterFamily(["status_class"]);
  const durations = createHistogram();
  const family = (
    name: string,
    type: "counter" | "gauge" | "histogram",
    help: string,
    lines: readonly string[],
  ) => [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines];
  return Object.freeze({
    observeEvent: (event) => {
      try {
        events.increment(eventLabels(event));
      } catch {
        // Losing a metric must never affect the request or domain behavior.
      }
    },
    observeRequest: ({ status, durationMs }) => {
      try {
        requests.increment([statusClassFor(status)]);
        if (Number.isFinite(durationMs) && durationMs >= 0)
          durations.observe(durationMs / 1000);
      } catch {
        // Losing a metric must never affect the request or domain behavior.
      }
    },
    render: (gauges) =>
      [
        ...family(
          "dotrelay_events_total",
          "counter",
          "Application Diagnostic Events by event name, outcome and problem code.",
          events.lines("dotrelay_events_total"),
        ),
        ...family(
          "dotrelay_http_requests_total",
          "counter",
          "Completed API requests by status class, excluding /health and /ready.",
          requests.lines("dotrelay_http_requests_total"),
        ),
        ...family(
          "dotrelay_http_request_duration_seconds",
          "histogram",
          "API request duration, excluding /health and /ready.",
          durations.lines("dotrelay_http_request_duration_seconds"),
        ),
        ...(gauges?.ready === undefined
          ? []
          : family(
              "dotrelay_ready",
              "gauge",
              "1 when the readiness check passes at scrape time, otherwise 0.",
              [`dotrelay_ready ${gauges.ready ? 1 : 0}`],
            )),
        "",
      ].join("\n"),
  });
};

const digest = (value: string) => createHash("sha256").update(value).digest();

const authorized = (request: Request, token: string | undefined) => {
  if (token === undefined) return true;
  const header = request.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Equal-length digests keep the comparison constant-time.
  return timingSafeEqual(digest(presented), digest(token));
};

/**
 * The private metrics listener's fetch handler. It serves only GET /metrics,
 * never shares the public API's routes, CORS or cookies, and checks the
 * bearer token when one is configured.
 */
export const createMetricsHandler = (
  options: Readonly<{
    readonly registry: MetricsRegistry;
    readonly token?: string;
    readonly ready: () => Promise<boolean>;
    readonly onReadiness?: (ready: boolean) => void;
  }>,
) => {
  const plain = (body: string, status: number, headers = {}) =>
    new Response(body, {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        ...headers,
      },
    });
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== "/metrics")
      return plain("not found\n", 404);
    if (!["GET", "HEAD"].includes(request.method))
      return plain("method not allowed\n", 405, { Allow: "GET, HEAD" });
    if (!authorized(request, options.token))
      return plain("unauthorized\n", 401, {
        "WWW-Authenticate": 'Bearer realm="dotrelay-metrics"',
      });
    const ready = await options.ready().catch(() => false);
    options.onReadiness?.(ready);
    return new Response(
      request.method === "HEAD" ? null : options.registry.render({ ready }),
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": METRICS_CONTENT_TYPE,
        },
      },
    );
  };
};

/** Starts the private metrics listener when enabled; otherwise does nothing. */
export const startMetricsServer = (
  config: MetricsConfig,
  options: Omit<Parameters<typeof createMetricsHandler>[0], "token">,
) => {
  if (!config.enabled) return undefined;
  const server = Bun.serve({
    port: config.port,
    fetch: createMetricsHandler({
      ...options,
      ...(config.token === undefined ? {} : { token: config.token }),
    }),
    maxRequestBodySize: 1024,
  });
  console.error(`DotRelay metrics listening on port ${config.port}`);
  return server;
};
