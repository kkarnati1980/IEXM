import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runMigrations } from "../src/db/migrator.mjs";

// ─── Unit: file filter regex ───────────────────────────────────────────────

const MIGRATION_FILE_RE = /^\d+_[a-z0-9_]+\.sql$/;

test("MIGRATION_FILE_RE accepts standard forward migrations", () => {
  assert.ok(MIGRATION_FILE_RE.test("001_init.sql"));
  assert.ok(MIGRATION_FILE_RE.test("029_notification_worker_state.sql"));
  assert.ok(MIGRATION_FILE_RE.test("064_moderation_status_enum.sql"));
});

test("MIGRATION_FILE_RE rejects .rollback.sql files", () => {
  assert.ok(!MIGRATION_FILE_RE.test("037_phase1_rbac_foundation.rollback.sql"));
  assert.ok(!MIGRATION_FILE_RE.test("041_privacy_audit_log.rollback.sql"));
  assert.ok(!MIGRATION_FILE_RE.test("050_tenants_compliance_status.rollback.sql"));
});

test("MIGRATION_FILE_RE rejects non-numeric-prefix files", () => {
  assert.ok(!MIGRATION_FILE_RE.test("README.sql"));
  assert.ok(!MIGRATION_FILE_RE.test("migration.sql"));
  assert.ok(!MIGRATION_FILE_RE.test("_init.sql"));
});

test("MIGRATION_FILE_RE rejects files with uppercase or hyphens in stem", () => {
  assert.ok(!MIGRATION_FILE_RE.test("001_Init.sql"));
  assert.ok(!MIGRATION_FILE_RE.test("001_my-migration.sql"));
});

// ─── Integration: reconcileOnly against in-memory stub DB ─────────────────

function makeStubDb(existingVersions = []) {
  const migrations = new Set(existingVersions);
  const executedSql = [];
  return {
    migrations,
    executedSql,
    async query(sql, params) {
      if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT 1 FROM schema_migrations")) {
        const version = params[0];
        return { rows: migrations.has(version) ? [{ 1: 1 }] : [] };
      }
      if (sql.includes("INSERT INTO schema_migrations")) {
        const version = params[0];
        migrations.add(version);
        return { rows: [] };
      }
      executedSql.push(sql);
      return { rows: [] };
    },
    async withTransaction(fn) {
      const tx = {
        async query(sql, params) {
          if (sql.includes("INSERT INTO schema_migrations")) {
            const version = params[0];
            migrations.add(version);
            return { rows: [] };
          }
          executedSql.push(sql);
          return { rows: [] };
        },
      };
      await fn(tx);
    },
  };
}

test("reconcileOnly records version without executing migration SQL", async () => {
  const dir = path.join(tmpdir(), `migrator-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, "001_create_things.sql"), "CREATE TABLE things (id TEXT);");
    const db = makeStubDb();
    await runMigrations(db, dir, { reconcileOnly: true });
    assert.ok(db.migrations.has("001_create_things"), "version should be recorded");
    assert.equal(db.executedSql.length, 0, "no migration SQL should have executed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcileOnly skips already-recorded versions", async () => {
  const dir = path.join(tmpdir(), `migrator-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, "001_create_things.sql"), "CREATE TABLE things (id TEXT);");
    const db = makeStubDb(["001_create_things"]);
    await runMigrations(db, dir, { reconcileOnly: true });
    assert.ok(db.migrations.has("001_create_things"), "version still recorded");
    assert.equal(db.executedSql.length, 0, "no SQL executed for already-recorded version");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcileOnly ignores .rollback.sql files in directory", async () => {
  const dir = path.join(tmpdir(), `migrator-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, "001_create_things.sql"), "CREATE TABLE things (id TEXT);");
    await writeFile(path.join(dir, "001_create_things.rollback.sql"), "DROP TABLE things;");
    const db = makeStubDb();
    await runMigrations(db, dir, { reconcileOnly: true });
    assert.ok(db.migrations.has("001_create_things"), "forward version recorded");
    assert.ok(!db.migrations.has("001_create_things.rollback"), "rollback version NOT recorded");
    assert.equal(db.executedSql.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normal mode (reconcileOnly=false) executes SQL via transaction", async () => {
  const dir = path.join(tmpdir(), `migrator-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, "001_create_things.sql"), "CREATE TABLE things (id TEXT);");
    const db = makeStubDb();
    await runMigrations(db, dir);
    assert.ok(db.migrations.has("001_create_things"), "version recorded");
    assert.ok(db.executedSql.some((s) => s.includes("CREATE TABLE things")), "SQL was executed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normal mode skips .rollback.sql files", async () => {
  const dir = path.join(tmpdir(), `migrator-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, "001_create_things.sql"), "CREATE TABLE things (id TEXT);");
    await writeFile(path.join(dir, "001_create_things.rollback.sql"), "DROP TABLE things;");
    const db = makeStubDb();
    await runMigrations(db, dir);
    assert.ok(db.migrations.has("001_create_things"), "forward recorded");
    assert.ok(!db.migrations.has("001_create_things.rollback"), "rollback not recorded");
    assert.ok(!db.executedSql.some((s) => s.includes("DROP TABLE")), "DROP not executed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
