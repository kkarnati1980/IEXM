import { createMemoryRepositories } from "./repositories/memory.mjs";
import { createPostgresRepositories } from "./repositories/postgres.mjs";

export function createRepositories({ backend = "memory", state, db } = {}) {
  if (backend === "postgres") {
    return createPostgresRepositories(db);
  }
  return createMemoryRepositories(state);
}
