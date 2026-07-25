import Redis from "ioredis";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
const valkeyUrl = process.env.VALKEY_URL ?? "redis://127.0.0.1:6379";
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

const sql = postgres(databaseUrl, { max: 1 });
const redis = new Redis(valkeyUrl, { lazyConnect: true });
try {
  const rows = await sql`SELECT 1 AS ready`;
  if (rows[0]?.ready !== 1)
    throw new Error("PostgreSQL readiness query returned an unexpected value");
  await redis.connect();
  if ((await redis.ping()) !== "PONG")
    throw new Error("Valkey readiness query did not return PONG");
  console.log("✓ PostgreSQL and Valkey integration services responded");
} finally {
  await Promise.all([sql.end(), redis.quit()]);
}
