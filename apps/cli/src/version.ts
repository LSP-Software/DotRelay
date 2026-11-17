// A release build stamps this identifier with `bun build --define` so the
// compiled binary reports the release it was cut from. Source and development
// runs keep the foundation identifier.
declare const __DOTRELAY_RELEASE_VERSION__: string;

// A build stamps the Server Profile origin it ships targeting (the hosted
// service for a release, the dev API for the dev channel), so an installed
// binary knows the service it belongs to and is pinned to it on first use.
// Source runs stamp no origin and need `dotrelay setup` first.
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
