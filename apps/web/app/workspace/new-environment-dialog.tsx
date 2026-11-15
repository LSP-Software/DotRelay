"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
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
  type CreatedEnvironment,
  createProjectEnvironment,
  environmentLabelError,
} from "@/lib/team-administration";

// Creates an empty Environment in the selected Project. Owners and Admins
// only; the service enforces the same rule. The new Environment has no
// revisions until someone publishes its first variables.
export const NewEnvironmentDialog = ({
  apiOrigin,
  projectId,
  projectName,
  deviceId,
  existingLabels,
  onCreated,
}: Readonly<{
  readonly apiOrigin: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly deviceId: string | undefined;
  readonly existingLabels: readonly string[];
  readonly onCreated: (environment: CreatedEnvironment) => void;
}>) => {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => {
    setLabel("");
    setError(null);
    setBusy(false);
  };
  const submit = async () => {
    const invalid = environmentLabelError(label);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (existingLabels.includes(label.trim())) {
      setError(
        `${projectName} already has an environment named ${label.trim()}.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    const result = await createProjectEnvironment(
      apiOrigin,
      projectId,
      label,
      deviceId,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    reset();
    onCreated(result.data);
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
      open={open}
    >
      <Button onClick={() => setOpen(true)} size="sm" variant="outline">
        <Plus aria-hidden="true" /> New environment
      </Button>
      <DialogContent data-testid="new-environment-dialog">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New environment</DialogTitle>
            <DialogDescription>
              Adds an empty environment to {projectName}. Everyone on the team
              can open it; add its first variables after it's created.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="new-environment-label">Name</Label>
            <Input
              aria-describedby={error ? "new-environment-error" : undefined}
              aria-invalid={error !== null}
              autoComplete="off"
              id="new-environment-label"
              maxLength={63}
              onChange={(event) => {
                setLabel(event.target.value);
                setError(null);
              }}
              placeholder="staging"
              spellCheck={false}
              value={label}
            />
            {error ? (
              <p
                className="text-sm text-destructive"
                id="new-environment-error"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={busy} type="submit">
              {busy ? "Creating…" : "Create environment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
