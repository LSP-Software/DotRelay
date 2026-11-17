import { MonitorSmartphone } from "lucide-react";
import type { Metadata } from "next";
import { CommandText } from "@/components/inline-command";
import { SiteShell } from "@/components/site-shell";
import { oauthErrorMessage } from "@/lib/oauth-error";
import { DeviceApproveCard } from "./device-approve-card";

export const metadata: Metadata = {
  title: "Allow this CLI",
  description: "Approve the DotRelay CLI using the code it shows",
};

const DevicePage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly user_code?: string;
    readonly error?: string;
  }>;
}) => {
  const { user_code: userCode, error } = await searchParams;
  const signInError = oauthErrorMessage(error);

  return (
    <SiteShell>
      <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
        <MonitorSmartphone aria-hidden="true" />
      </span>
      <div className="mt-4 space-y-5">
        {signInError ? (
          <p className="text-sm text-destructive" role="alert">
            {signInError}
          </p>
        ) : null}
        {userCode ? (
          <DeviceApproveCard autoSignIn={!signInError} userCode={userCode} />
        ) : (
          <>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              Allow this CLI?
            </h1>
            <p className="text-sm text-muted-foreground">
              <CommandText text="Open this page from `dotrelay setup` or `dotrelay login` so the code is included." />
            </p>
          </>
        )}
      </div>
    </SiteShell>
  );
};

export default DevicePage;
