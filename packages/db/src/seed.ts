import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { loadRootEnv } from "./loadRootEnv.js";
import { makeDb, users, workerStatus } from "./index.js";

loadRootEnv();

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in the environment");
  process.exit(1);
}

const db = makeDb(process.env.DATABASE_URL!);
const hash = await bcrypt.hash(password, 10);

await db
  .insert(users)
  .values({ email, passwordHash: hash })
  .onConflictDoUpdate({ target: users.email, set: { passwordHash: hash } });

// The heartbeat row is a singleton: the dashboard reads it before any worker has run.
const [existing] = await db.select({ id: workerStatus.id }).from(workerStatus).where(eq(workerStatus.id, 1));
if (existing) {
  await db.update(workerStatus).set({ lastSeenAt: new Date() }).where(eq(workerStatus.id, 1));
} else {
  await db.insert(workerStatus).values({ id: 1, lastSeenAt: new Date(0) });
}

console.log(`Seeded user ${email}`);
process.exit(0);
