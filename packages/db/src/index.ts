import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export * from "./schema.js";
export * from "./dedup.js";
export * from "./delete.js";
export * from "./loadRootEnv.js";

type SqlClient = ReturnType<typeof postgres>;

/**
 * `pglite-socket` (the dev DB and the test DB) serves every TCP connection from one
 * Postgres session and queues wire messages a single message at a time, so the worker's
 * transaction and the dashboard's polling interleave: a statement parsed by one
 * connection is the statement the other connection then binds against. That answers a
 * six-parameter select with `bind message supplies 6 parameters, but prepared statement
 * "" requires 8` — killing the connection and the job running on it — or, worse, with the
 * other query's row. An unnamed statement is the shared part; a name is private, so
 * postgres.js is asked to use one for every query.
 *
 * The catch is that Drizzle sends all of its SQL through `client.unsafe(text, values)`,
 * which hard-codes `prepare: false` regardless of the client option, so the only way in is
 * to pass each call its own `{ prepare: true }` — and to keep doing it for the transaction
 * client Drizzle is handed back, which is where every collected lead is written.
 *
 * Off by default because it is a dev-DB workaround, not a production one: behind Neon's
 * pooled host a statement prepared on one backend is missing from the next.
 */
function namedStatements(client: SqlClient): SqlClient {
  if (process.env.DB_NAMED_STATEMENTS !== "true") return client;
  // The two calls are forwarded to the very functions being replaced; only postgres.js's
  // generic parameter types get in the way of saying so.
  const unsafe = client.unsafe as unknown as (
    text: string,
    values: readonly unknown[],
    options?: Record<string, unknown>,
  ) => unknown;
  const begin = client.begin as unknown as (...args: unknown[]) => unknown;
  return new Proxy(client, {
    get: (target, property) => {
      if (property === "unsafe") {
        return (text: string, values: readonly unknown[] = [], options: Record<string, unknown> = {}) =>
          unsafe(text, values, { ...options, prepare: true });
      }
      if (property === "begin") {
        return (...args: unknown[]) => {
          const at = args.findIndex((arg) => typeof arg === "function");
          if (at >= 0) {
            const body = args[at] as (tx: SqlClient) => unknown;
            args[at] = (tx: SqlClient) => body(namedStatements(tx));
          }
          return begin(...args);
        };
      }
      return Reflect.get(target, property);
    },
  });
}

export function makeDb(databaseUrl: string) {
  // One connection by default: postgres.js pipelines queries on it, so nothing is lost, and
  // Neon's free tier prefers the process holding few backends. `pglite-socket` (the dev DB and
  // the test DB) can take more than one now that `namedStatements` and the read-level grouping
  // in `scripts/pgliteSocket.ts` stop its connections from answering each other, but a raise is
  // a deliberate act — `POOL_MAX` — rather than something that silently breaks a job mid-run.
  const client = postgres(databaseUrl, {
    max: Number(process.env.POOL_MAX ?? 1),
    idle_timeout: 20,
  });
  return drizzle(namedStatements(client), { schema });
}

export type Db = ReturnType<typeof makeDb>;
