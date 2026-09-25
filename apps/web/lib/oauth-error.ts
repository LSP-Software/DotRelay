const oauthErrorMessages: Readonly<Record<string, string>> = {
  access_denied: "GitHub sign-in was cancelled.",
  email_not_found: "GitHub didn't share an email address for this account.",
  invalid_code: "GitHub sign-in expired before it finished. Try again.",
  state_mismatch:
    "GitHub sent you back without the sign-in this page started. Try again from here.",
};

// Only known OAuth error codes get a specific sentence. Anything else still
// tells the operator the attempt failed, without echoing the query value.
export const oauthErrorMessage = (code: string | undefined): string | null => {
  if (!code) return null;
  return oauthErrorMessages[code] ?? "GitHub sign-in didn't finish. Try again.";
};
