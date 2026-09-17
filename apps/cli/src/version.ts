// A release build stamps this identifier with `bun build --define` so the
// compiled binary reports the release it was cut from. Source and development
// runs keep the foundation identifier.
declare const __DOTRELAY_RELEASE_VERSION__: string;

// A dev build stamps the Server Profile origin it ships targeting, so a
// binary installed from the dev channel knows the service it belongs to.
// Release builds and source runs stamp no origin and require an explicit
// `dotrelay setup <origin>` trust decision.
declare const __DOTRELAY_DEFAULT_ORIGIN__: string;

export const version: string =
  typeof __DOTRELAY_RELEASE_VERSION__ === "string" &&
  __DOTRELAY_RELEASE_VERSION__.length > 0
    ? __DOTRELAY_RELEASE_VERSION__
    : "0.0.0-foundation";

export const defaultOrigin: string | undefined =
  typeof __DOTRELAY_DEFAULT_ORIGIN__ === "string" &&
  __DOTRELAY_DEFAULT_ORIGIN__.length > 0
    ? __DOTRELAY_DEFAULT_ORIGIN__
    : undefined;
