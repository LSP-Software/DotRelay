// The hosted DotRelay service's API origin. Next-action text that asks for
// `dotrelay setup <origin>` names it as the example, so a new user does not
// have to discover it; a self-hosted installation substitutes its own.
export const HOSTED_ORIGIN = "https://api.dotrelay.dev";

export const setupHint = `dotrelay setup ${HOSTED_ORIGIN} (or your own origin if you self-host)`;
