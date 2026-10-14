import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * npm runs workspace scripts from the package directory, so `dotenv/config` looks
 * for a .env that isn't there. Walk up from this module to find the repo root's.
 * Shell variables still win: dotenv never overwrites a value that is already set.
 */
export function loadRootEnv(startDir = dirname(fileURLToPath(import.meta.url))): void {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
