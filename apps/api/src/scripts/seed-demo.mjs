import { createPostgresDatabase } from "../db/postgres.mjs";
import { seedDemoData } from "../db/seed-demo.mjs";

const db = await createPostgresDatabase({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true",
  sslRejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false"
});

try {
  await seedDemoData(db);

  console.log("Demo seed inserted");
} finally {
  await db.close();
}
