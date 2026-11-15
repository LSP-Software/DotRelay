import { describe, expect, test } from "bun:test";
import { createProblem } from "@dotrelay/contracts";
import { Hono } from "hono";
import { createInMemoryAuth } from "./auth";
import { createApi } from "./index";
import {
  createMetricsHandler,
  createMetricsRegistry,
  METRICS_CONTENT_TYPE,
  statusClassFor,
} from "./metrics";
import { DEFAULT_METRICS_PORT, loadMetricsConfig } from "./metrics-config";
import {
  createApiObservability,
  createInMemoryDiagnosticSink,
  createServerCorrelationId,
  type ServerDiagnosticEvent,
} from "./observability";
import { loadServerProfileConfig } from "./profile";
import {
  createUserRateLimit,
  RATE_LIMIT_BUCKET_CONTEXT_KEY,
} from "./protocol/rate-limit";

const token = "metrics-fixture-token-0123456789abcdef";

const sample = (text: string, name: string, labels: string) => {
  const line = text
    .split("\n")
    .find((entry) => entry.startsWith(`${name}{${labels}} `));
  return line === undefined ? 0 : Number(line.split(" ").at(-1));
};

const eventCount = (
  text: string,
  eventName: string,
  outcome = "failure",
  problemCode = "none",
) =>
  sample(
    text,
    "dotrelay_events_total",
    `event_name="${eventName}",outcome="${outcome}",problem_code="${problemCode}"`,
  );

const request = (
  observability: ReturnType<typeof createApiObservability>,
  input: Partial<Parameters<typeof observability.recordRequest>[0]> & {
    readonly path: string;
    readonly status: number;
  },
) =>
  observability.recordRequest({
    request: new Request(`https://relay.example${input.path}`),
    correlationId: createServerCorrelationId(),
    durationMs: 12,
    ...input,
  });

describe("metrics registry", () => {
  test("renders Prometheus text with only allowlisted label values", () => {
    const registry = createMetricsRegistry();
    const correlationId = createServerCorrelationId();
    registry.observeEvent({
      schemaVersion: 1,
      eventName: "api.request.completed",
      correlationId,
      outcome: "failure",
      problemCode: "authentication_required",
    });
    // Values outside the allowlists are bucketed, never echoed.
    registry.observeEvent({
      schemaVersion: 1,
      eventName: "api.user.alice@example.com",
      correlationId,
      outcome: "maybe",
      problemCode: "team-11111111-1111-4111-8111-111111111111",
    } as unknown as ServerDiagnosticEvent);
    registry.observeRequest({ status: 503, durationMs: 30 });
    registry.observeRequest({ status: 200, durationMs: 2 });
    registry.observeRequest({ status: 999, durationMs: Number.NaN });

    const text = registry.render({ ready: false });
    expect(text).toContain("# TYPE dotrelay_events_total counter\n");
    expect(
      eventCount(
        text,
        "api.request.completed",
        "failure",
        "authentication_required",
      ),
    ).toBe(1);
    expect(eventCount(text, "other", "other", "other")).toBe(1);
    expect(text).not.toContain("alice");
    expect(text).not.toContain("11111111");
    expect(text).not.toContain(correlationId);
    expect(
      sample(text, "dotrelay_http_requests_total", 'status_class="5xx"'),
    ).toBe(1);
    expect(
      sample(text, "dotrelay_http_requests_total", 'status_class="other"'),
    ).toBe(1);
    expect(text).toContain(
      'dotrelay_http_request_duration_seconds_bucket{le="0.05"} 2\n',
    );
    expect(text).toContain(
      'dotrelay_http_request_duration_seconds_bucket{le="+Inf"} 2\n',
    );
    expect(text).toContain("dotrelay_http_request_duration_seconds_count 2\n");
    expect(text).toContain("# TYPE dotrelay_ready gauge\ndotrelay_ready 0\n");
    expect(text.endsWith("\n")).toBe(true);
    for (const line of text.split("\n").filter(Boolean))
      expect(line).toMatch(
        /^(# (HELP|TYPE) [a-z_]+ .+|[a-z_]+(\{[a-z_]+="[A-Za-z0-9._+]+"(,[a-z_]+="[A-Za-z0-9._+]+")*\})? \d+(\.\d+)?)$/,
      );
  });

  test("cardinality is bounded by construction", () => {
    const registry = createMetricsRegistry();
    const correlationId = createServerCorrelationId();
    for (let index = 0; index < 5_000; index += 1)
      registry.observeEvent({
        schemaVersion: 1,
        eventName: `api.request.${index}`,
        correlationId,
        problemCode: `code_${index}`,
      } as unknown as ServerDiagnosticEvent);
    for (let status = 0; status < 2_000; status += 1)
      registry.observeRequest({ status, durationMs: 1 });
    const text = registry.render();
    const series = text
      .split("\n")
      .filter((line) => line.startsWith("dotrelay_events_total{"));
    expect(series).toEqual([
      'dotrelay_events_total{event_name="other",outcome="none",problem_code="other"} 5000',
    ]);
    expect(
      text
        .split("\n")
        .filter((line) => line.startsWith("dotrelay_http_requests_total{")),
    ).toHaveLength(6);
    expect(statusClassFor(404)).toBe("4xx");
    expect(statusClassFor(42)).toBe("other");
  });
});

describe("metrics fed from observability events", () => {
  const setup = (database: unknown = {}) => {
    const registry = createMetricsRegistry();
    const diagnostics = createInMemoryDiagnosticSink(() => 0);
    const observability = createApiObservability(database as never, {
      diagnostics,
      metrics: registry,
      random: () => 1,
      sampleRate: 0,
    });
    return { registry, diagnostics, observability };
  };

  test("counts every request, including sampled-out successes, but not probes", () => {
    const { registry, diagnostics, observability } = setup();
    request(observability, { path: "/api/v1/session", status: 200 });
    request(observability, {
      path: "/api/v1/session",
      status: 401,
      problemCode: "authentication_required",
    });
    request(observability, {
      path: "/api/v1/teams",
      status: 503,
      problemCode: "service_unavailable",
    });
    request(observability, { path: "/health", status: 200 });
    request(observability, { path: "/ready", status: 503 });
    const text = registry.render();
    expect(eventCount(text, "api.request.completed", "success")).toBe(1);
    expect(
      eventCount(
        text,
        "api.request.completed",
        "failure",
        "authentication_required",
      ),
    ).toBe(1);
    expect(
      sample(text, "dotrelay_http_requests_total", 'status_class="2xx"'),
    ).toBe(1);
    expect(
      sample(text, "dotrelay_http_requests_total", 'status_class="5xx"'),
    ).toBe(1);
    expect(text).toContain("dotrelay_http_request_duration_seconds_count 3\n");
    expect(eventCount(text, "api.readiness.checked")).toBe(1);
    expect(
      diagnostics
        .records()
        .filter((event) => event.eventName === "api.request.completed"),
    ).toHaveLength(3);
  });

  test("counts rate-limit refusals by limiter bucket and backend outages", () => {
    const { registry, diagnostics, observability } = setup();
    for (const [path, bucket] of [
      ["/api/v1/teams", "api"],
      ["/api/v1/operations/x/begin", "protocol"],
      ["/api/v1/github-users/resolve", "github"],
      ["/api/v1/teams", "create"],
      ["/api/v1/teams", "unexpected"],
      ["/api/auth/sign-in/social", undefined],
    ] as const)
      request(observability, {
        path,
        status: 429,
        problemCode: "rate_limited",
        ...(bucket === undefined ? {} : { rateLimitBucket: bucket }),
      });
    request(observability, {
      path: "/api/v1/teams",
      status: 503,
      problemCode: "rate_limit_unavailable",
    });
    const text = registry.render();
    const refused = (name: string) =>
      eventCount(text, `api.rate_limit.${name}`, "failure", "rate_limited");
    expect(refused("user_refused")).toBe(3);
    expect(refused("github_refused")).toBe(1);
    expect(refused("creation_refused")).toBe(1);
    expect(refused("auth_refused")).toBe(1);
    expect(
      eventCount(
        text,
        "api.rate_limit.unavailable",
        "failure",
        "rate_limit_unavailable",
      ),
    ).toBe(1);
    // The same events reach the logs for operators without Prometheus.
    expect(diagnostics.records().map((event) => event.eventName)).toContain(
      "api.rate_limit.github_refused",
    );
  });

  test("counts retention cleanup runs and expiry failures", async () => {
    let failStaging = false;
    const transaction = {
      operation: {
        findMany: async () => {
          if (failStaging) throw new Error("staging unavailable");
          return [];
        },
      },
      stagedObject: { deleteMany: async () => ({ count: 0 }) },
      securityRequestLog: { deleteMany: async () => ({ count: 0 }) },
      $executeRaw: async () => 0,
    };
    const { registry, observability } = setup({
      $transaction: async (callback: (value: unknown) => unknown) =>
        callback(transaction),
      // Deleted Teams past their purge window (ADR 0019): none here.
      team: { findMany: async () => [] },
    });
    await observability.runRetentionCleanup();
    failStaging = true;
    await expect(observability.runRetentionCleanup()).rejects.toThrow();
    const text = registry.render();
    expect(eventCount(text, "api.retention.cleanup_completed", "success")).toBe(
      1,
    );
    expect(eventCount(text, "api.retention.cleanup_completed", "failure")).toBe(
      1,
    );
    expect(eventCount(text, "api.staging.expiry_failed")).toBe(1);
  });

  test("counts readiness checks; only failures are logged", () => {
    const { registry, diagnostics, observability } = setup();
    observability.recordReadiness(true);
    observability.recordReadiness(false);
    const text = registry.render();
    expect(eventCount(text, "api.readiness.checked", "success")).toBe(1);
    expect(eventCount(text, "api.readiness.checked", "failure")).toBe(1);
    expect(diagnostics.records()).toEqual([
      expect.objectContaining({
        eventName: "api.readiness.checked",
        outcome: "failure",
      }),
    ]);
  });

  test("the API passes the refusing limiter bucket to request metrics", async () => {
    const profile = loadServerProfileConfig({});
    const records: Array<Record<string, unknown>> = [];
    const testApp = createApi({
      database: {} as never,
      profile,
      auth: createInMemoryAuth(profile),
      observability: {
        diagnostics: { emit: () => undefined },
        expireSecurityRequestLogs: async () => 0,
        expireShortLivedRecords: async () => ({}),
        expireStaging: async () => ({ operations: 0, stagedObjects: 0 }),
        runRetentionCleanup: async () => undefined,
        recordReadiness: () => undefined,
        recordRequest: (input) => records.push(input),
      },
    });
    testApp.get("/test-refused", (context) => {
      context.set(RATE_LIMIT_BUCKET_CONTEXT_KEY as never, "github");
      return context.json(createProblem("rate_limited"), 429, {
        "Content-Type": "application/problem+json",
      });
    });
    await testApp.request(`${profile.origin}/test-refused`);
    expect(records[0]).toMatchObject({
      problemCode: "rate_limited",
      rateLimitBucket: "github",
    });

    // The public API never serves metrics.
    const metrics = await testApp.request(`${profile.origin}/metrics`);
    expect(metrics.status).toBe(404);
    expect(await metrics.text()).not.toContain("dotrelay_");
  });

  test.skipIf(!process.env.VALKEY_URL)(
    "the per-User limiter names the refusing bucket",
    async () => {
      const app = new Hono();
      let bucket: unknown;
      app.use("*", async (context, next) => {
        await next();
        bucket = context.get(RATE_LIMIT_BUCKET_CONTEXT_KEY as never);
      });
      app.use(
        "*",
        createUserRateLimit({
          isProduction: true,
          identify: async () => `metrics-test-${crypto.randomUUID()}`,
          buckets: () => [{ name: "github", limit: 0, windowSeconds: 60 }],
        }),
      );
      app.get("*", (context) => context.text("ok"));
      expect((await app.request("/api/v1/teams")).status).toBe(429);
      expect(bucket).toBe("github");
    },
  );
});

describe("private metrics endpoint", () => {
  const handler = (options: { token?: string; ready?: boolean } = {}) => {
    const readiness: boolean[] = [];
    const registry = createMetricsRegistry();
    registry.observeRequest({ status: 200, durationMs: 1 });
    return {
      readiness,
      fetch: createMetricsHandler({
        registry,
        ...(options.token === undefined ? {} : { token: options.token }),
        ready: async () => options.ready ?? true,
        onReadiness: (ready) => readiness.push(ready),
      }),
    };
  };

  test("requires the bearer token when one is configured", async () => {
    const { fetch, readiness } = handler({ token });
    for (const authorization of [
      undefined,
      "Bearer ",
      "Bearer wrong",
      `Bearer ${token}x`,
      `Basic ${token}`,
      token,
    ]) {
      const response = await fetch(
        new Request("http://metrics/metrics", {
          headers:
            authorization === undefined ? {} : { Authorization: authorization },
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toStartWith("Bearer");
      expect(await response.text()).not.toContain("dotrelay_");
    }
    expect(readiness).toEqual([]);

    const response = await fetch(
      new Request("http://metrics/metrics", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(METRICS_CONTENT_TYPE);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const text = await response.text();
    expect(text).toContain("dotrelay_ready 1\n");
    expect(text).toContain(
      'dotrelay_http_requests_total{status_class="2xx"} 1',
    );
    expect(readiness).toEqual([true]);
  });

  test("serves only GET /metrics and reports readiness at scrape time", async () => {
    const { fetch, readiness } = handler({ ready: false });
    expect((await fetch(new Request("http://metrics/"))).status).toBe(404);
    expect((await fetch(new Request("http://metrics/health"))).status).toBe(
      404,
    );
    expect(
      (await fetch(new Request("http://metrics/metrics", { method: "POST" })))
        .status,
    ).toBe(405);
    const response = await fetch(new Request("http://metrics/metrics"));
    expect(await response.text()).toContain("dotrelay_ready 0\n");
    expect(readiness).toEqual([false]);
  });

  test("configuration is off by default and requires a token in production", () => {
    expect(loadMetricsConfig({}, true)).toEqual({
      enabled: false,
      port: DEFAULT_METRICS_PORT,
    });
    expect(
      loadMetricsConfig({ METRICS_ENABLED: "false", METRICS_TOKEN: "x" }, true)
        .enabled,
    ).toBe(false);
    expect(loadMetricsConfig({ METRICS_ENABLED: "true" }, false)).toEqual({
      enabled: true,
      port: DEFAULT_METRICS_PORT,
    });
    expect(
      loadMetricsConfig(
        { METRICS_ENABLED: "true", METRICS_PORT: "9100", METRICS_TOKEN: token },
        true,
      ),
    ).toEqual({ enabled: true, port: 9100, token });
    for (const environment of [
      { METRICS_ENABLED: "yes" },
      { METRICS_ENABLED: "true" },
      { METRICS_ENABLED: "true", METRICS_TOKEN: "short-token" },
      { METRICS_ENABLED: "true", METRICS_TOKEN: token, METRICS_PORT: "0" },
      { METRICS_ENABLED: "true", METRICS_TOKEN: token, METRICS_PORT: "abc" },
      { METRICS_ENABLED: "true", METRICS_TOKEN: token, METRICS_PORT: "3001" },
      {
        METRICS_ENABLED: "true",
        METRICS_TOKEN: token,
        PORT: "8080",
        METRICS_PORT: "8080",
      },
    ])
      expect(() => loadMetricsConfig(environment, true)).toThrow();
    let message = "";
    try {
      loadMetricsConfig(
        { METRICS_ENABLED: "true", METRICS_TOKEN: "secret-but-short" },
        true,
      );
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("METRICS_TOKEN must be at least");
    expect(message).not.toContain("secret-but-short");
  });
});
