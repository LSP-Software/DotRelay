import postgres from "postgres";

const databaseName = "dotrelay_shadow";
const sql = postgres(
  process.env.DATABASE_ADMIN_URL ??
    "postgresql://dotrelay:dotrelay@127.0.0.1:5432/postgres",
  { max: 1 },
);

try {
  const existing = await sql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname = ${databaseName}
  `;

  if (existing.length === 0) {
    await sql.unsafe(`CREATE DATABASE "${databaseName}"`);
  }

  console.log(`✓ PostgreSQL shadow database is ready: ${databaseName}`);
} finally {
  await sql.end({ timeout: 5 });
}
