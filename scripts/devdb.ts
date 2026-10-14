/**
 * Dev-only Postgres for machines without Docker: PGlite (real Postgres/WASM) exposed on the
 * wire protocol so the web app and the worker can connect as separate processes. Data
 * persists in ./data/pgdata. Production uses Neon.
 *
 *   npm run db:dev   [port]
 */
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { startPgLiteSocketServer } from "./pgliteSocket";

const port = Number(process.argv[2] ?? 5434);

// No top-level await: this file is a .ts in a package without `"type": "module"`, so tsx
// compiles it to CommonJS, which cannot start one.
async function main(): Promise<void> {
  mkdirSync("./data/pgdata", { recursive: true });
  const db = new PGlite("./data/pgdata");
  // Short-lived scripts (migrations, smoke tests, one-off queries) each hold a connection
  // until the OS reclaims it, and the server only frees a slot when it manages to read from
  // the dead socket. A tight cap shows up as `read ECONNRESET` on the next connect, so the
  // dev server leaves plenty of headroom.
  await startPgLiteSocketServer({ db, port, maxConnections: 30 });
  console.log(`PGlite dev DB listening on postgres://localhost:${port}/pglite`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
