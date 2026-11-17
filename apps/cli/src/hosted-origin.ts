import { defaultOrigin } from "./version";

// The hosted DotRelay service's API origin.
export const HOSTED_ORIGIN = "https://api.dotrelay.dev";

// The server `dotrelay setup` connects to when no address is given: the
// origin this build ships targeting (the dev channel stamps the dev API, a
// release stamps the hosted service), else the hosted service. Only a
// self-hosted installation needs to name its own address.
export const setupOrigin: string = defaultOrigin ?? HOSTED_ORIGIN;

export const setupHint = "dotrelay setup";
