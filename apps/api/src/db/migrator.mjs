import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Accepts only NNN_name.sql — rejects .rollback.sql and any non-migration .sql files
const MIGRATION_FILE_RE = /^\d+_[a-z0-9_]+\.sql$/;

export async function runMigrations(db, migrationsDir, { reconcileOnly = false } = {}) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const exists = await db.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if (exists.rows.length) {
      continue;
    }
    if (reconcileOnly) {
      await db.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [version]
      );
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await db.withTransaction(async (tx) => {
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    });
  }
}

export function defaultMigrationsDir() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "..", "migrations");
}
