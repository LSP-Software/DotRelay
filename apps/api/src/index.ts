import { Hono } from "hono";

export const app = new Hono().get("/health", (context) =>
  context.json({ status: "ok" }),
);

if (import.meta.main) {
  Bun.serve({
    fetch: app.fetch,
    port: Number(process.env.PORT ?? 3001),
  });
}
