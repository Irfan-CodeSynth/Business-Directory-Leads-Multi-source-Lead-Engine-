import { loadRootEnv, makeDb } from "@dleads/db";

loadRootEnv();

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set — copy .env.example to .env at the repo root.");
  process.exit(1);
}

/** The queue is this database: `jobs` rows are claimed with FOR UPDATE SKIP LOCKED. */
export const db = makeDb(url);
