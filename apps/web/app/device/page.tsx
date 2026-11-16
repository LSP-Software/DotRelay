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
      <h1 className="mt-4 font-heading text-2xl font-semibold tracking-tight">
        Allow this CLI?
      </h1>
      <p className="mt-2 text-muted-foreground">
        A DotRelay CLI is asking to sign in as you. Only allow it if you started
        this sign-in from your own terminal just now and it shows the code
        below.
      </p>
      <p className="mt-3 text-sm text-muted-foreground">
        Allowing gives that terminal access to your DotRelay account, including
        your teams, invitations and roles. It still can&apos;t decrypt your
        values until you set it up as one of your devices.
      </p>
      <div className="mt-6 space-y-5">
        {signInError ? (
          <p className="text-sm text-destructive" role="alert">
            {signInError}
          </p>
        ) : null}
        {userCode ? (
          <>
            <p className="rounded-lg border bg-card px-3 py-3 text-center font-mono text-xl tracking-[0.3em]">
              {userCode}
            </p>
            <DeviceApproveCard userCode={userCode} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            <CommandText text="Open this page from `dotrelay setup` or `dotrelay login` so the code is included." />
          </p>
        )}
      </div>
    </SiteShell>
  );
};

export default DevicePage;
