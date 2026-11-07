// Response security headers for the web app. This app holds decrypted
// values and unwraps the Account Master Key in the browser, so script
// execution is limited to nonce-tagged framework scripts (and what they load,
// via 'strict-dynamic'), and the page can only talk to itself and the
// configured DotRelay API.

export type SecurityHeaderOptions = Readonly<{
  /** Per-request nonce; Next.js tags its scripts with it during render. */
  readonly nonce: string;
  /** The configured API origin, if any; added to connect-src. */
  readonly apiOrigin?: string | undefined;
  /** NODE_ENV === "development": React needs eval for dev-only debugging. */
  readonly development: boolean;
  /** NODE_ENV === "production": adds HSTS. */
  readonly production: boolean;
}>;

const originOf = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const { origin } = new URL(value);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
};

export const buildContentSecurityPolicy = (
  options: SecurityHeaderOptions,
): string => {
  const apiOrigin = originOf(options.apiOrigin);
  const directives: readonly (readonly string[])[] = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      `'nonce-${options.nonce}'`,
      "'strict-dynamic'",
      ...(options.development ? ["'unsafe-eval'"] : []),
    ],
    // React and Base UI set style attributes and Next.js injects style
    // elements, so inline styles stay allowed (no nonce here, which would
    // disable 'unsafe-inline').
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "https://avatars.githubusercontent.com"],
    ["font-src", "'self'"],
    ["connect-src", "'self'", ...(apiOrigin ? [apiOrigin] : [])],
    // The Argon2 password KDF runs in a Worker built from a blob: URL.
    ["worker-src", "'self'", "blob:"],
    ["frame-ancestors", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'self'"],
    ["object-src", "'none'"],
  ];
  return directives.map((directive) => directive.join(" ")).join("; ");
};

export const buildSecurityHeaders = (
  options: SecurityHeaderOptions,
): Readonly<Record<string, string>> => ({
  "Content-Security-Policy": buildContentSecurityPolicy(options),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  ...(options.production
    ? {
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      }
    : {}),
});

export const createNonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
};
