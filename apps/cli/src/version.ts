// A release build stamps this identifier with `bun build --define` so the
// compiled binary reports the release it was cut from. Source and development
// runs keep the foundation identifier.
declare const __DOTRELAY_RELEASE_VERSION__: string;

export const version: string =
  typeof __DOTRELAY_RELEASE_VERSION__ === "string" &&
  __DOTRELAY_RELEASE_VERSION__.length > 0
    ? __DOTRELAY_RELEASE_VERSION__
    : "0.0.0-foundation";
