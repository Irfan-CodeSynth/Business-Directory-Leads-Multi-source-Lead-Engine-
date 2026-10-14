import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "./session";

export function currentUserId(): number | null {
  return verifySession(cookies().get(SESSION_COOKIE)?.value);
}
