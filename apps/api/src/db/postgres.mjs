import { HttpError } from "../http-error.mjs";

export async function createPostgresDatabase({
  connectionString,
  ssl = false,
  sslRejectUnauthorized = true,
  max = 10
} = {}) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for postgres backend");
  }

  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString,
    max,
    ssl: ssl ? { rejectUnauthorized: sslRejectUnauthorized } : false
  });

  async function applySecurityContext(connection, context = {}) {
    if (context.databaseRole) {
      await connection.query(`SET LOCAL ROLE ${context.databaseRole}`);
    }
    await connection.query(
      `SELECT
        set_config('app.tenant_id', $1, true),
        set_config('app.actor_id', $2, true),
        set_config('app.actor_role', $3, true)`,
      [context.tenantId ?? "", context.actorId ?? "", context.actorRole ?? ""]
    );
  }

  return {
    async query(text, params = []) {
      return pool.query(text, params);
    },
    async queryWithContext(context, text, params = []) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await applySecurityContext(client, context);
        const result = await client.query(text, params);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async withTransaction(callback) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = {
          query(text, params = []) {
            return client.query(text, params);
          },
          async applySecurityContext(context) {
            await applySecurityContext(client, context);
          }
        };
        const result = await callback(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async healthcheck() {
      await pool.query("SELECT 1");
      return { ok: true };
    },
    async close() {
      await pool.end();
    }
  };
}

export function rowOrThrow(result, label) {
  if (!result.rows.length) {
    throw new HttpError(404, `${label} not found`);
  }
  return result.rows[0];
}
