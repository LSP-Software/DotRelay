import { type NextProxy, NextResponse } from "next/server";
import { buildSecurityHeaders, createNonce } from "@/lib/security-headers";
import { resolveLiveApiOrigin } from "@/lib/workspace-boundary";

// Every rendered response carries a per-request nonce CSP plus the static
// security headers. Next.js reads the nonce from the request's
// Content-Security-Policy header and tags its own scripts with it, which is
// why the root layout renders per request.
export const proxy: NextProxy = (request) => {
  const nonce = createNonce();
  const headers = buildSecurityHeaders({
    nonce,
    apiOrigin: resolveLiveApiOrigin(),
    development: process.env.NODE_ENV === "development",
    production: process.env.NODE_ENV === "production",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(
    "Content-Security-Policy",
    headers["Content-Security-Policy"] ?? "",
  );
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers))
    response.headers.set(name, value);
  return response;
};

export const config = {
  // Hashed build assets need no per-request policy.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
