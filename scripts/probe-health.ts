export {};
// Container liveness: /ready deliberately fails during drain and while
// dependencies are down, which must not make Docker restart the process.
const response = await fetch(
  `http://127.0.0.1:${process.env.PORT ?? "3001"}/health`,
  { signal: AbortSignal.timeout(4000) },
);
process.exit(response.ok ? 0 : 1);
