// During the private alpha the API admits only listed GitHub accounts. A
// signed-in account outside the list gets this problem code on every
// request but sign-out, and the web shows /private-alpha for it instead of
// a generic error.
export const ALPHA_ADMISSION_PROBLEM = "alpha_admission_required";
export const PRIVATE_ALPHA_PATH = "/private-alpha";
export const HOSTED_SUPPORT_EMAIL = "support@dotrelay.dev";

export const isAlphaAdmissionProblem = (
  status: number,
  body: unknown,
): boolean =>
  status === 403 &&
  body !== null &&
  typeof body === "object" &&
  (body as { readonly code?: unknown }).code === ALPHA_ADMISSION_PROBLEM;

/** Reads a clone, so the caller can still consume the body. */
export const isAlphaAdmissionResponse = async (
  response: Response,
): Promise<boolean> =>
  response.status === 403 &&
  isAlphaAdmissionProblem(
    403,
    await response
      .clone()
      .json()
      .catch(() => null),
  );

/**
 * Only DotRelay's hosted service takes access requests by email; a
 * self-hosted server's operator decides who it admits.
 */
export const alphaAccessRequestHref = (hosted: boolean): string | null =>
  hosted
    ? `mailto:${HOSTED_SUPPORT_EMAIL}?subject=${encodeURIComponent(
        "DotRelay alpha access request",
      )}&body=${encodeURIComponent("GitHub username: ")}`
    : null;
