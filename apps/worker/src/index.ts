import { db } from "./db.js";
import { claimJob, closeOrphanedSourceStats, processJob, requeueRunningJobs } from "./job.js";
import { heartbeat, WORKER_VERSION } from "./heartbeat.js";
import { osmConfig } from "./adapters/osm.js";
import { sleep } from "./adapters/types.js";

const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);

let stopping = false;
process.on("SIGINT", () => {
  console.log("\nstopping after this job (Ctrl-C again to force)");
  if (stopping) process.exit(130);
  stopping = true;
});

// A database still waking up (Neon suspends free-tier compute) must not kill the
// worker before it starts polling; the loop retries from the next tick.
let requeued = 0;
try {
  requeued = await requeueRunningJobs(db);
} catch (err) {
  console.error(`could not requeue at boot: ${err instanceof Error ? err.message : err}`);
}
if (requeued > 0) console.log(`requeued ${requeued} job(s) left running by a previous shutdown`);

try {
  const healed = await closeOrphanedSourceStats(db);
  if (healed > 0) console.log(`closed ${healed} source row(s) left running by an interrupted worker`);
} catch (err) {
  console.error(`could not close orphaned source rows: ${err instanceof Error ? err.message : err}`);
}

const osm = osmConfig();
console.log(`worker ${WORKER_VERSION} · queue is the jobs table · polling every ${POLL_MS} ms`);
if (/example\.com/i.test(osm.userAgent)) {
  // Verified against the live gateways: a placeholder domain is refused outright
  // (Nominatim 403, Overpass 406), which otherwise reads like an IP ban.
  console.warn("WARNING: OSM_USER_AGENT still contains example.com — Overpass and Nominatim will refuse it.");
}

for (;;) {
  if (stopping) {
    await heartbeat(db, null).catch(() => {});
    console.log("worker stopped");
    break;
  }

  let job = null;
  try {
    job = await claimJob(db);
  } catch (err) {
    console.error(`could not claim a job: ${err instanceof Error ? err.message : err}`);
  }

  if (!job) {
    await heartbeat(db, null).catch(() => {});
    await sleep(POLL_MS);
    continue;
  }

  console.log(
    `job ${job.id}: [${job.keywords.join(", ")}] x [${job.locations.join(", ")}] via ${job.sources.join(", ")}`,
  );
  await heartbeat(db, job.id).catch(() => {});
  try {
    await processJob(db, job, { heartbeat: () => heartbeat(db, job.id) });
  } catch (err) {
    // processJob records its own failures; reaching here means the database itself
    // moved under us, so the job stays `running` and the next boot requeues it.
    console.error(`job ${job.id} aborted: ${err instanceof Error ? err.message : err}`);
  }
  await heartbeat(db, null).catch(() => {});
}
