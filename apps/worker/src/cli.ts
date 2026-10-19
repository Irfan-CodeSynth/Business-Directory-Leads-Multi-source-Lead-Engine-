/**
 * Smoke test one source without Postgres:
 *   npx tsx src/cli.ts osm "plumber" "Austin, TX" 15
 *
 * Nothing is written to the database — this only proves the adapter, its tag
 * parsing and its courtesy ladder work against the live service.
 */
import { loadRootEnv } from "@dleads/db";
import { createOsmAdapter } from "./adapters/osm.js";
import { BlockedError, BudgetExhaustedError, makeBudget, type RawLead } from "./adapters/types.js";

// Adapter config is read lazily per request, so hoisted imports are safe here.
loadRootEnv();

const asJson = process.argv.includes("--json");
const leads: RawLead[] = [];

const adapter = createOsmAdapter();
const [sourceArg, keyword, location, maxArg] = process.argv.slice(2);

if (sourceArg !== "osm") {
  console.error(`No driver for source "${sourceArg ?? ""}". This build ships "osm".`);
  console.error('usage: tsx src/cli.ts osm "<keyword>" "<location>" [maxItems] [--json]');
  process.exit(2);
}
if (!keyword || !location) {
  console.error('usage: tsx src/cli.ts osm "<keyword>" "<location>" [maxItems] [--json]');
  process.exit(1);
}

const maxItems = Math.max(1, Math.min(200, Number(maxArg) || 15));

try {
  const outcome = await adapter.search(
    { keyword, location, maxItems },
    {
      emit: (lead) => {
        leads.push(lead);
        if (asJson) return;
        const contacts = [
          lead.phone ? `tel ${lead.phone}` : "no phone",
          lead.emails?.length ? `mailto ${lead.emails[0]}` : "",
          lead.website ?? "",
        ]
          .filter(Boolean)
          .join("  ");
        console.log(`  ${String(leads.length).padStart(2)}. ${lead.name} ${lead.category ? `[${lead.category}]` : ""}  ${contacts}`);
      },
      budget: makeBudget(Number(process.env.CLI_MAX_REQUESTS ?? 40)),
      log: (message) => console.error(asJson ? `# ${message}` : `  ! ${message}`),
      shouldStop: () => false,
    },
  );

  if (asJson) {
    console.log(JSON.stringify(leads, null, 2));
  } else {
    console.log(`\n${outcome.emitted} lead(s) from ${outcome.requestsUsed} request(s)`);
    if (outcome.stopped) console.log("(stopped early on request)");
    if (leads.length > 0) {
      console.log(`\nprofile: ${leads[0].profileUrl}`);
      console.log("data is © OpenStreetMap contributors (ODbL).");
    }
  }
} catch (err) {
  if (err instanceof BlockedError) {
    console.error(`\nBLOCKED${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`);
    console.error("A job would mark this source `blocked`, still finish `done`, and can re-run it later.");
    process.exit(3);
  }
  if (err instanceof BudgetExhaustedError) {
    console.error(`\n${err.message} — raise CLI_MAX_REQUESTS if that was the intent.`);
    process.exit(4);
  }
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
