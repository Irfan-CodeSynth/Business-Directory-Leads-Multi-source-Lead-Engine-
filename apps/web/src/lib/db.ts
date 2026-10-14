import "server-only";
import { makeDb, type Db } from "@dleads/db";

let singleton: Db | null = null;

export function getDb(): Db {
  if (!singleton) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    singleton = makeDb(url);
  }
  return singleton;
}
