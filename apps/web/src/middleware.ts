import { NextResponse, type NextRequest } from "next/server";

// Middleware runs on the edge runtime, so it cannot use node:crypto. It only
// checks that the session cookie exists and is well-formed; the authoritative
// HMAC verification happens in server routes/components via lib/session.
const COOKIE = "dleads_session";
const SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function middleware(req: NextRequest) {
  const value = req.cookies.get(COOKIE)?.value;
  const valid = !!value && SHAPE.test(value);
  if (valid) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/auth).*)"],
};
