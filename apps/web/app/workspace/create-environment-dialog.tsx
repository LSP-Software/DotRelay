"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type EnvironmentVariable,
  type EnvironmentVariableSeedChoice,
  seedEnvironmentVariables,
  validateEnvironmentLabel,
} from "@/lib/environment-workflow";
import type { WorkspaceEnvironmentSummary } from "@/lib/workspace-boundary";

const EMPTY_SOURCE = "";
const seedChoiceLabels: Readonly<
  Record<EnvironmentVariableSeedChoice, string>
> = {
  copy: "Copy value",
  blank: "Leave blank",
  omit: "Don't include",
};

export const CreateEnvironmentDialog = ({
  open,
  onOpenChange,
  environments,
  defaultSourceId,
  variablesByEnvironment,
  fallbackVariables,
  existingLabels,
  creating = false,
  error,
  onCreate,
}: Readonly<{
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environments: readonly WorkspaceEnvironmentSummary[];
  readonly defaultSourceId: string | null;
  readonly variablesByEnvironment: Readonly<
    Record<string, readonly EnvironmentVariable[]>
  >;
  readonly fallbackVariables: readonly EnvironmentVariable[];
  readonly existingLabels: readonly string[];
  readonly creating?: boolean;
  readonly error?: string | null;
  readonly onCreate: (input: {
    readonly label: string;
    readonly sourceEnvironmentId: string | null;
    readonly variables: readonly EnvironmentVariable[];
  }) => void;
}>) => {
  const [label, setLabel] = useState("");
  const [sourceId, setSourceId] = useState(defaultSourceId ?? EMPTY_SOURCE);
  const [bulkChoice, setBulkChoice] =
    useState<EnvironmentVariableSeedChoice>("copy");
  const [choiceOverrides, setChoiceOverrides] = useState<
    Readonly<Partial<Record<string, EnvironmentVariableSeedChoice>>>
  >({});
  const [labelError, setLabelError] = useState<string | null>(null);
  const activeEnvironments = environments.filter(
    (environment) => environment.lifecycle === "ACTIVE",
  );
  const sourceVariables = useMemo(() => {
    if (!sourceId) return [];
    return (variablesByEnvironment[sourceId] ?? fallbackVariables).filter(
      (variable) => !variable.tombstone,
    );
  }, [fallbackVariables, sourceId, variablesByEnvironment]);

  useEffect(() => {
    if (!open) return;
    setLabel("");
    setSourceId(defaultSourceId ?? EMPTY_SOURCE);
    setBulkChoice("copy");
    setChoiceOverrides({});
    setLabelError(null);
  }, [defaultSourceId, open]);

  const choiceFor = (variableId: string): EnvironmentVariableSeedChoice =>
    choiceOverrides[variableId] ?? bulkChoice;

  const submit = () => {
    const nextError = validateEnvironmentLabel(label, existingLabels);
    if (nextError) {
      setLabelError(nextError);
      return;
    }
    onCreate({
      label: label.trim(),
      sourceEnvironmentId: sourceId || null,
      variables: seedEnvironmentVariables(
        sourceVariables,
        Object.fromEntries(
          sourceVariables.map((variable) => [
            variable.id,
            choiceFor(variable.id),
          ]),
        ),
        () => globalThis.crypto.randomUUID(),
      ),
    });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Environment</DialogTitle>
          <DialogDescription>
            Name it, then choose which Variables to take from an existing
            Environment. Values stay in this browser.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="new-environment-label">Label</Label>
            <Input
              autoComplete="off"
              id="new-environment-label"
              onChange={(event) => {
                setLabel(event.target.value);
                setLabelError(null);
              }}
              placeholder="staging"
              value={label}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-environment-source">Base Environment</Label>
            <select
              className="h-9 rounded-lg border border-input bg-input/30 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id="new-environment-source"
              onChange={(event) => {
                setSourceId(event.target.value);
                setChoiceOverrides({});
              }}
              value={sourceId}
            >
              <option value={EMPTY_SOURCE}>Start empty</option>
              {activeEnvironments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.label}
                </option>
              ))}
            </select>
          </div>
          {sourceVariables.length > 0 ? (
            <div className="grid gap-3">
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">
                  For every Variable
                </legend>
                <div className="flex flex-wrap gap-2">
                  {(["copy", "blank", "omit"] as const).map((choice) => (
                    <label
                      className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5"
                      key={choice}
                    >
                      <input
                        checked={bulkChoice === choice}
                        name="environment-seed-bulk"
                        onChange={() => {
                          setBulkChoice(choice);
                          setChoiceOverrides({});
                        }}
                        type="radio"
                      />
                      {seedChoiceLabels[choice]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid max-h-[min(40vh,22rem)] gap-2 overflow-y-auto">
                {sourceVariables.map((variable) => (
                  <fieldset
                    className="grid gap-2 rounded-lg border p-3"
                    data-testid={`environment-seed-${variable.name}`}
                    key={variable.id}
                  >
                    <legend className="px-1 text-sm font-medium">
                      <span className="font-mono">{variable.name}</span>
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {variable.ownership === "SHARED_VALUE"
                          ? "Shared Value"
                          : "User-defined Value"}
                      </span>
                    </legend>
                    <div className="flex flex-wrap gap-3">
                      {(["copy", "blank", "omit"] as const).map((choice) => (
                        <label
                          className="flex cursor-pointer items-center gap-2 text-sm"
                          key={choice}
                        >
                          <input
                            aria-label={`${seedChoiceLabels[choice]} for ${variable.name}`}
                            checked={choiceFor(variable.id) === choice}
                            name={`environment-seed-${variable.id}`}
                            onChange={() =>
                              setChoiceOverrides((current) => ({
                                ...current,
                                [variable.id]: choice,
                              }))
                            }
                            type="radio"
                          />
                          {seedChoiceLabels[choice]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
            </div>
          ) : sourceId ? (
            <p className="text-sm text-muted-foreground">
              Open that Environment first if you want to copy its Variables.
            </p>
          ) : null}
          {labelError || error ? (
            <p className="text-sm text-destructive" role="alert">
              {labelError ?? error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button disabled={creating} onClick={submit}>
            {creating ? "Creating…" : "Create Environment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
