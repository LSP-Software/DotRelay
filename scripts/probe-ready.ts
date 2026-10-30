export {};
const response = await fetch(
  `http://127.0.0.1:${process.env.PORT ?? "3001"}/ready`,
  { signal: AbortSignal.timeout(4000) },
);
process.exit(response.ok ? 0 : 1);
