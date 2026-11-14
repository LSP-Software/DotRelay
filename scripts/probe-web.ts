export {};
// Web liveness for orchestrator health checks that run in the railpack image
// (Coolify): the Next.js server answers /api/health.
const response = await fetch(
  `http://127.0.0.1:${process.env.PORT ?? "3000"}/api/health`,
  { signal: AbortSignal.timeout(4000) },
);
process.exit(response.ok ? 0 : 1);
