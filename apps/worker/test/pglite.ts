import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { makeDb, type Db } from "@dleads/db";
import { startPgLiteSocketServer } from "../../../scripts/pgliteSocket";

/**
 * A real Postgres, in memory, on the wire — the same `postgres.js` + Drizzle path the
 * worker uses in production, and nothing is ever written to `./data/pgdata`, so a test
 * run cannot touch the dev database (port 5434) or any other project's.
 */

const MIGRATIONS = new URL("../../../packages/db/drizzle/", import.meta.url);

export interface TestDb {
  db: Db;
  url: string;
  close(): Promise<void>;
}

async function applyMigrations(memory: PGlite): Promise<void> {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(new URL(file, MIGRATIONS), "utf8");
    for (const chunk of raw.split("--> statement-breakpoint")) {
      const statement = chunk.trim().replace(/;\s*$/, "");
      if (statement) await memory.query(statement);
    }
  }
}

export async function startTestDb(firstPort: number): Promise<TestDb> {
  const memory = new PGlite();
  await applyMigrations(memory);

  let lastError: unknown;
  for (let port = firstPort; port < firstPort + 10; port++) {
    // Headroom above any pool a test could build, so a failure below this line is the
    // database misbehaving and never `too many connections` from the harness.
    let server: Awaited<ReturnType<typeof startPgLiteSocketServer>>;
    try {
      server = await startPgLiteSocketServer({ db: memory, port, maxConnections: 20 });
    } catch (err) {
      lastError = err;
      continue;
    }
    const url = `postgres://127.0.0.1:${port}/pglite`;
    const db = makeDb(url);
    return {
      db,
      url,
      close: async () => {
        await server.stop();
        await memory.close();
      },
    };
  }
  throw new Error(`no free port from ${firstPort}: ${String(lastError)}`);
}

const TABLES = [
  "lead_sources",
  "lead_contacts",
  "known_businesses",
  "job_source_stats",
  "leads",
  "jobs",
  "website_observations",
] as const;

/** Tests share one database per file; wipe it instead of trusting isolation. */
export async function truncateAll(db: Db): Promise<void> {
  // Every linked table in one statement: listing the children explicitly is what
  // keeps Postgres from printing a "truncate cascades to ..." notice per test.
  await db.execute(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")}` as never);
}
