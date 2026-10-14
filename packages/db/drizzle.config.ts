import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

// npm runs workspace scripts from packages/db, so the repo-root .env has to be
// loaded explicitly. Without this `npm run db:migrate` silently gets an empty URL.
for (const candidate of ["../../.env", ".env"]) {
  if (existsSync(candidate)) dotenv.config({ path: candidate });
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
