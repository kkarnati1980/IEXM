import { createPostgresDatabase } from "../db/postgres.mjs";
import { defaultMigrationsDir, runMigrations } from "../db/migrator.mjs";

const db = await createPostgresDatabase({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true",
  sslRejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false"
});

try {
  await runMigrations(db, defaultMigrationsDir());
  console.log("Migrations applied");
} finally {
  await db.close();
}
