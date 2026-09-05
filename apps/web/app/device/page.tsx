import { Braces, MonitorSmartphone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DeviceApproveCard } from "./device-approve-card";

export const metadata: Metadata = {
  title: "Allow this CLI",
  description: "Allow a DotRelay CLI on this machine",
};

const DevicePage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly user_code?: string }>;
}) => {
  const { user_code: userCode } = await searchParams;

  return (
    <main className="landing-grid grid min-h-screen place-items-center px-5 py-12">
      <div className="w-full max-w-md">
        <Link className="mb-8 flex items-center justify-center gap-3" href="/">
          <span className="grid size-9 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <Braces aria-hidden="true" className="size-5" />
          </span>
          <span className="font-heading text-lg font-semibold">DotRelay</span>
        </Link>
        <Card className="border-primary/15 bg-card/90 shadow-2xl backdrop-blur">
          <CardHeader className="space-y-2">
            <div className="mb-3 grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <MonitorSmartphone aria-hidden="true" />
            </div>
            <CardTitle className="text-2xl">
              <h1>Allow this CLI?</h1>
            </CardTitle>
            <CardDescription>
              The CLI on this machine is waiting for you to allow it. Values
              stay on the Device. This only creates a session.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {userCode ? (
              <>
                <p className="rounded-lg border bg-background/60 px-3 py-2 text-center font-mono text-lg tracking-[0.3em]">
                  {userCode}
                </p>
                <DeviceApproveCard userCode={userCode} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Open this page from <code>dotrelay setup</code> or{" "}
                <code>dotrelay login</code> so the code is included.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
};

export default DevicePage;
