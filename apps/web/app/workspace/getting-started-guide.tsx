"use client";

import { useEffect, useState } from "react";
import { CopyableCommand } from "@/components/copyable-command";
import { InlineCommand } from "@/components/inline-command";
import { Button } from "@/components/ui/button";
import {
  CLI_INIT_COMMAND,
  CLI_PACKAGE_MANAGERS,
  type CliPackageManager,
  cliInstallCommand,
  type GettingStartedModel,
  type GettingStartedStep,
  readCliPackageManager,
  writeCliPackageManager,
} from "@/lib/getting-started";
import { cn } from "@/lib/utils";

const stepTitle = (step: GettingStartedStep): string => {
  switch (step.id) {
    case "cli":
      return "Set up the CLI";
    case "team":
      return "Create your team";
    case "browser":
      return "Set up this browser";
    case "recovery":
      return "Save your recovery code";
    default: {
      const unreachable: never = step.id;
      return unreachable;
    }
  }
};

const StepBody = ({
  step,
  setupCommand,
  installCommand,
  packageManager,
  invited,
  offerCli,
  deviceSetupInProgress,
  deviceSetupMessage,
  onEnroll,
  onRecovery,
  onPackageManagerChange,
}: Readonly<{
  step: GettingStartedStep;
  setupCommand: string;
  installCommand: string;
  packageManager: CliPackageManager;
  invited: boolean;
  offerCli: boolean;
  deviceSetupInProgress: boolean;
  deviceSetupMessage: string | null;
  onEnroll: () => void;
  onRecovery: () => void;
  onPackageManagerChange: (manager: CliPackageManager) => void;
}>) => {
  if (step.status === "later") {
    return (
      <p className="mt-1 text-sm text-muted-foreground">
        {step.id === "cli" ? (
          <>
            Install the CLI, then run <InlineCommand value={setupCommand} />.
          </>
        ) : null}
        {step.id === "team" ? (
          <>
            In the repository, run <InlineCommand value={CLI_INIT_COMMAND} />.
          </>
        ) : null}
        {step.id === "browser" ? "This browser needs its own keys." : null}
        {step.id === "recovery"
          ? "Save a code to unlock your account later."
          : null}
      </p>
    );
  }

  if (step.id === "recovery") {
    return (
      <>
        <p className="mt-1 text-sm text-muted-foreground">
          Save a recovery code somewhere safe before adding values.
        </p>
        <Button className="mt-3" onClick={onRecovery} type="button">
          Open Recovery
        </Button>
      </>
    );
  }

  if (step.id === "cli") {
    return (
      <>
        <p className="mt-1 text-sm text-muted-foreground">
          Install the CLI and sign in to this server.
        </p>
        <div className="mt-3 grid gap-2">
          <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
            <legend className="sr-only">Install the CLI with</legend>
            <span className="mr-1 text-xs text-muted-foreground">
              Install with
            </span>
            {CLI_PACKAGE_MANAGERS.map((manager) => (
              <Button
                aria-pressed={packageManager === manager}
                className="h-6 px-2 font-mono text-xs"
                data-testid={`getting-started-package-manager-${manager}`}
                key={manager}
                onClick={() => onPackageManagerChange(manager)}
                size="xs"
                type="button"
                variant={packageManager === manager ? "default" : "outline"}
              >
                {manager}
              </Button>
            ))}
          </fieldset>
          <CopyableCommand
            data-testid="getting-started-install-command"
            value={installCommand}
          />
          <CopyableCommand
            data-testid="getting-started-setup-command"
            value={setupCommand}
          />
        </div>
      </>
    );
  }

  if (step.id === "team") {
    return (
      <>
        <p className="mt-1 text-sm text-muted-foreground">
          Run this in your Git repository to create your team and first
          environment.
          {invited
            ? " If a team invited you, accept that invitation above instead. You stay pending until a device receives the project's keys."
            : null}
        </p>
        <CopyableCommand className="mt-3" value={CLI_INIT_COMMAND} />
      </>
    );
  }

  return (
    <>
      <p className="mt-1 text-sm text-muted-foreground">
        This browser needs its own keys to read values.
      </p>
      {offerCli ? (
        <>
          <CopyableCommand
            className="mt-3"
            data-testid="getting-started-setup-command"
            value={setupCommand}
          />
          <p className="mt-2 text-sm text-muted-foreground">
            You can also set up the CLI separately.
          </p>
        </>
      ) : null}
      {deviceSetupMessage ? (
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          {deviceSetupMessage}
        </p>
      ) : null}
      <Button
        className="mt-3"
        disabled={deviceSetupInProgress}
        onClick={onEnroll}
        type="button"
      >
        {deviceSetupInProgress ? "Setting up…" : "Set up browser"}
      </Button>
    </>
  );
};

export const GettingStartedGuide = ({
  model,
  setupCommand,
  invited,
  standalone,
  deviceSetupInProgress,
  deviceSetupMessage,
  onEnroll,
  onRecovery,
  onContinue,
}: Readonly<{
  model: GettingStartedModel;
  setupCommand: string;
  invited: boolean;
  standalone: boolean;
  deviceSetupInProgress: boolean;
  deviceSetupMessage: string | null;
  onEnroll: () => void;
  onRecovery: () => void;
  onContinue: (() => void) | null;
}>) => {
  const Title = standalone ? "h1" : "h2";
  const offerCli = !model.steps.some((step) => step.id === "cli");
  const [packageManager, setPackageManager] =
    useState<CliPackageManager>("npm");
  useEffect(() => {
    // Read after mount so the server render and the first client render
    // agree on the npm default, then the saved machine preference wins.
    setPackageManager(readCliPackageManager());
  }, []);
  const choosePackageManager = (manager: CliPackageManager) => {
    if (manager === packageManager) return;
    setPackageManager(manager);
    writeCliPackageManager(manager);
  };
  const guide = (
    <section className="mb-8" data-testid="getting-started">
      <p className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground">
        FIRST RUN
      </p>
      <Title className="mt-2 font-heading text-3xl font-semibold tracking-tight">
        Get started
      </Title>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        {model.steps[0]?.id === "cli"
          ? "Install the CLI, then create your first team from your repository."
          : "Finish these steps to open your workspace."}
      </p>
      <ol className="mt-6 grid list-none gap-3 p-0">
        {model.steps.map((step, index) => {
          const Heading = step.status === "current" ? "h2" : "p";
          return (
            <li
              aria-current={step.status === "current" ? "step" : undefined}
              className={cn(
                "rounded-xl border px-4 py-3",
                step.status === "current" &&
                  "border-amber-300/40 bg-amber-300/5",
                step.status === "later" && "border-border",
              )}
              key={step.id}
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border font-mono text-[11px]",
                    step.status === "current" &&
                      "border-amber-300/40 text-amber-200",
                    step.status === "later" &&
                      "border-border text-muted-foreground",
                  )}
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <Heading
                    className={cn(
                      "font-heading text-base font-medium",
                      step.status === "later" && "text-muted-foreground",
                    )}
                  >
                    {stepTitle(step)}
                  </Heading>
                  <StepBody
                    deviceSetupInProgress={deviceSetupInProgress}
                    deviceSetupMessage={deviceSetupMessage}
                    installCommand={cliInstallCommand(packageManager)}
                    invited={invited}
                    offerCli={offerCli}
                    onEnroll={onEnroll}
                    onRecovery={onRecovery}
                    onPackageManagerChange={choosePackageManager}
                    packageManager={packageManager}
                    setupCommand={setupCommand}
                    step={step}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {onContinue ? (
        <Button
          className="mt-4"
          data-testid="getting-started-continue"
          onClick={onContinue}
          type="button"
          variant="outline"
        >
          Continue to projects
        </Button>
      ) : null}
    </section>
  );

  if (!standalone) return guide;
  return <div data-testid="no-teams-empty">{guide}</div>;
};

export const GettingStartedResume = ({
  onShow,
}: Readonly<{ onShow: () => void }>) => (
  <div
    className="mb-6 flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    data-testid="getting-started-collapsed"
  >
    <p className="text-sm text-muted-foreground">
      This browser is not ready to read values yet.
    </p>
    <Button onClick={onShow} type="button" variant="outline">
      Show setup steps
    </Button>
  </div>
);
