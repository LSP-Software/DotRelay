import { InlineCommand } from "@/components/inline-command";

// GitHub shows DotRelay only the repositories its GitHub App is installed on,
// and signing in installs nothing. Without this, `dotrelay init` cannot find
// a new user's repository and nothing says why.
export const GitHubAppAccessHint = ({
  installUrl,
}: Readonly<{ installUrl?: string | undefined }>) => (
  <p
    className="mt-2 text-sm text-muted-foreground"
    data-testid="github-app-access-hint"
  >
    DotRelay can only see repositories where its GitHub App is installed.{" "}
    {installUrl ? (
      <>
        If <InlineCommand value="dotrelay init" /> can&apos;t find yours,{" "}
        <a
          className="font-medium text-foreground underline underline-offset-4"
          data-testid="github-app-install-link"
          href={installUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          install the GitHub App and choose repositories
        </a>
        .
      </>
    ) : (
      <>
        If <InlineCommand value="dotrelay init" /> can&apos;t find yours, ask
        the server operator for the GitHub App install link.
      </>
    )}
  </p>
);
