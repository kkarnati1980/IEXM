export async function resetDatabase(db) {
  await db.query("DROP SCHEMA IF EXISTS public CASCADE");
  await db.query("CREATE SCHEMA public");
}
