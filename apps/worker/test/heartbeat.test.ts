import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { workerStatus, type Db } from "@dleads/db";
import { eq } from "drizzle-orm";
import { heartbeat, WORKER_VERSION } from "../src/heartbeat.js";
import { startTestDb, truncateAll, type TestDb } from "./pglite.js";

let db: Db;
let server: TestDb;

beforeAll(async () => {
  server = await startTestDb(5520);
  db = server.db;
});

afterAll(async () => {
  await server?.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

const row = async () => (await db.select().from(workerStatus).where(eq(workerStatus.id, 1)))[0] ?? null;

describe("heartbeat", () => {
  it("creates the single status row on the first poll", async () => {
    expect(await row()).toBeNull();
    await heartbeat(db, null);
    expect(await row()).toMatchObject({ id: 1, currentJobId: null, version: WORKER_VERSION });
  });

  it("refreshes the same row instead of adding a second one", async () => {
    await heartbeat(db, null);
    const first = await row();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await heartbeat(db, 42);

    const second = await row();
    expect(await db.select({ id: workerStatus.id }).from(workerStatus)).toHaveLength(1);
    expect(second!.lastSeenAt.getTime()).toBeGreaterThan(first!.lastSeenAt.getTime());
    expect(second!.currentJobId).toBe(42);
  });

  it("clears the job it was working on when the poll goes idle again", async () => {
    await heartbeat(db, 7);
    await heartbeat(db, null);
    expect((await row())!.currentJobId).toBeNull();
  });
});
