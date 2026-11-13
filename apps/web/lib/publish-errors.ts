import { ProtocolTransportError } from "@dotrelay/client";

// Turns a failed publication into a sentence a person can act on. Every
// message says the draft is kept, because it is: the editor holds it in
// memory and nothing here reloads the page. Advice never says "refresh the
// page", which would discard that draft; the editor's own Refresh control
// keeps it, so conflicts point there instead.

const KEPT = "Your draft is kept.";

const isNetworkFailure = (error: unknown, online: boolean): boolean =>
  !online ||
  // fetch rejects with a TypeError when the request never got a response.
  error instanceof TypeError ||
  (error instanceof Error && error.name === "NetworkError");

export const publishFailureMessage = (
  error: unknown,
  options: Readonly<{ readonly online?: boolean }> = {},
): string => {
  const online = options.online ?? true;
  if (isNetworkFailure(error, online))
    return `Couldn't reach the server, so nothing was published. ${KEPT} Check your connection and try again.`;
  if (!(error instanceof ProtocolTransportError))
    return `Publishing failed before it reached the server. ${KEPT} Try again.`;
  switch (error.problem.code) {
    case "authentication_required":
      return `Your session ended, so nothing was published. ${KEPT} Sign in again in a new tab, then come back here and try again.`;
    case "device_not_active":
      return `This browser's device is no longer active, so it can't publish. ${KEPT} Set up this browser again from Devices, then try again.`;
    case "membership_not_active":
    case "forbidden":
      return `Your team role doesn't allow this change, so nothing was published. ${KEPT} Ask a team owner or admin to make it.`;
    case "membership_not_key_provisioned":
      return `You don't have this project's keys yet, so nothing was published. ${KEPT} Ask a team owner or admin to share project keys with you, then try again.`;
    case "stale_epoch":
    case "stale_generation":
    case "rotation_required":
      return `This project's keys changed since this environment loaded, so nothing was published. ${KEPT} Wait for the workspace to pick up the new keys, then try again.`;
    case "archived_resource":
      return `This environment or its project was archived, so nothing was published. ${KEPT}`;
    case "resource_not_found":
      return `This environment no longer exists on the server, so nothing was published. ${KEPT}`;
    case "operation_conflict":
    case "state_conflict":
    case "genesis_exists":
      return `Someone else changed this environment at the same time, so nothing was published. ${KEPT} Use Refresh in the editor to load their changes, then try again.`;
    case "staging_expired":
    case "staged_object_missing":
      return `The publication took too long and expired before it finished. ${KEPT} Try again.`;
    case "payload_too_large":
      return `This change is too large to publish at once. ${KEPT} Publish it in smaller parts.`;
    case "rate_limited":
    case "rate_limit_unavailable":
      return `The server is limiting requests right now. ${KEPT} Wait a moment, then try again.`;
    case "service_unavailable":
    case "crypto_provider_unavailable":
      return `The server is unavailable right now, so nothing was published. ${KEPT} Try again in a moment.`;
    case "invalid_request":
    case "invalid_crypto_object":
    case "unsupported_api_version":
    case "unsupported_crypto_suite":
    case "unsupported_crypto_runtime":
    case "unsupported_media_type":
      return `The server refused this publication as invalid. ${KEPT} Try again; if it keeps happening, contact your server administrator.`;
    default:
      return `The server rejected this publication. ${KEPT} Try again.`;
  }
};
