"use client";

import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import { type DotenvEntry, DotenvError, parseDotenv } from "./dotenv";
import { type DotenvImportAction, planDotenvImport } from "./dotenv-import";
import type {
  EditorActor,
  EnvironmentVariable,
  VariableOwnership,
} from "./environment-workflow";

// The editor's bulk tools: importing pasted .env text into the draft and
// downloading the readable values as a .env file.

const actionLabel = (action: DotenvImportAction): string =>
  action.kind === "add"
    ? "Add"
    : action.kind === "update"
      ? "Update"
      : action.kind === "unchanged"
        ? "No change"
        : "Skipped";

type ParsedImport =
  | Readonly<{ readonly ok: true; readonly entries: readonly DotenvEntry[] }>
  | Readonly<{ readonly ok: false; readonly error: string }>;

const parseImport = (text: string): ParsedImport => {
  try {
    return { ok: true, entries: parseDotenv(text) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof DotenvError
          ? error.message
          : "This text couldn't be read as a .env file.",
    };
  }
};

export const ImportDotenvDialog = ({
  open,
  variables,
  actor,
  onOpenChange,
  onStage,
}: Readonly<{
  readonly open: boolean;
  readonly variables: readonly EnvironmentVariable[];
  readonly actor: EditorActor;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStage: (
    plan: readonly DotenvImportAction[],
    ownership: VariableOwnership,
  ) => void;
}>) => {
  const [text, setText] = useState("");
  const [ownership, setOwnership] = useState<VariableOwnership | "">("");
  const parsed = useMemo(() => parseImport(text), [text]);
  const plan = useMemo(
    () => (parsed.ok ? planDotenvImport(parsed.entries, variables, actor) : []),
    [parsed, variables, actor],
  );
  const adds = plan.filter((action) => action.kind === "add").length;
  const updates = plan.filter((action) => action.kind === "update").length;
  const stageable = adds + updates > 0 && (adds === 0 || ownership !== "");
  const close = (next: boolean) => {
    // Pasted text holds secrets; nothing keeps it once the dialog closes.
    if (!next) {
      setText("");
      setOwnership("");
    }
    onOpenChange(next);
  };
  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent
        className="sm:max-w-2xl"
        data-testid="import-dotenv-dialog"
      >
        <DialogHeader>
          <DialogTitle>Import .env</DialogTitle>
          <DialogDescription>
            Paste the contents of a .env file. New and changed values go into
            your draft for review; nothing is published until you save.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="import-dotenv-text">.env contents</Label>
            <textarea
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="min-h-36 w-full rounded-lg border border-input bg-input/30 px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              data-1p-ignore
              data-lpignore="true"
              id="import-dotenv-text"
              onChange={(event) => setText(event.target.value)}
              placeholder={"API_URL=https://example.test\nTOKEN='secret'"}
              spellCheck={false}
              value={text}
            />
          </div>
          {!parsed.ok && text.trim() !== "" ? (
            <p className="text-sm text-destructive" role="alert">
              {parsed.error}
            </p>
          ) : null}
          {plan.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-xs text-muted-foreground" role="status">
                {adds} to add, {updates} to update,{" "}
                {plan.length - adds - updates} unchanged or skipped
              </p>
              <ul
                aria-label="Import preview"
                className="grid max-h-[min(30vh,16rem)] gap-1 overflow-y-auto rounded-lg border p-2"
              >
                {plan.map((action) => (
                  <li
                    className="flex flex-wrap items-baseline gap-2 text-sm"
                    key={action.name}
                  >
                    <Badge
                      className="h-4 text-[10px]"
                      variant={
                        action.kind === "blocked" ? "outline" : "secondary"
                      }
                    >
                      {actionLabel(action)}
                    </Badge>
                    <span className="break-all font-mono">{action.name}</span>
                    {action.kind === "blocked" ? (
                      <span className="text-xs text-muted-foreground">
                        {action.reason}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {adds > 0 ? (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">
                Who can read the {adds} new variable{adds === 1 ? "" : "s"}?
              </legend>
              {(
                [
                  [
                    "SHARED_VALUE",
                    "Team",
                    "Everyone on the team reads the same value.",
                  ],
                  [
                    "USER_DEFINED_VALUE",
                    "Only me",
                    "Private to you. Only your devices can read it; teammates don't get it.",
                  ],
                ] as const
              ).map(([value, label, hint]) => (
                <label className="flex items-start gap-2 text-sm" key={value}>
                  <input
                    checked={ownership === value}
                    className="mt-1"
                    name="import-ownership"
                    onChange={() => setOwnership(value)}
                    type="radio"
                    value={value}
                  />
                  <span>
                    {label}
                    <span className="block text-xs text-muted-foreground">
                      {hint}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            disabled={!stageable}
            onClick={() => {
              if (!stageable) return;
              onStage(plan, ownership === "" ? "SHARED_VALUE" : ownership);
              close(false);
            }}
          >
            Add to draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const DownloadDotenvDialog = ({
  open,
  fileName,
  valueCount,
  unsetCount,
  hasDraft,
  onOpenChange,
  onDownload,
}: Readonly<{
  readonly open: boolean;
  readonly fileName: string;
  readonly valueCount: number;
  readonly unsetCount: number;
  readonly hasDraft: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDownload: () => void;
}>) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent data-testid="download-dotenv-dialog" role="alertdialog">
      <DialogHeader>
        <DialogTitle>Download .env</DialogTitle>
        <DialogDescription>
          This saves {valueCount} published value{valueCount === 1 ? "" : "s"}{" "}
          you can read to {fileName} on this computer, unencrypted.
        </DialogDescription>
      </DialogHeader>
      <Alert className="border-amber-300/30 bg-amber-300/5">
        <AlertTitle>The file holds your secrets in plain text</AlertTitle>
        <AlertDescription>
          Anyone or anything that can read your downloads folder can read them.
          Keep it out of version control and delete it when you're done.
          {unsetCount > 0
            ? ` ${unsetCount} variable${unsetCount === 1 ? " has" : "s have"} no value and ${unsetCount === 1 ? "is" : "are"} left out.`
            : null}
          {hasDraft ? " Unpublished draft changes are not included." : null}
        </AlertDescription>
      </Alert>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button onClick={onDownload}>Download</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

// Hands text to the browser as a file download. The object URL is revoked
// right after the click so the contents don't linger in a blob URL.
export const downloadTextFile = (fileName: string, contents: string) => {
  const url = URL.createObjectURL(
    new Blob([contents], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const dotenvFileName = (environmentLabel: string | undefined): string =>
  `${(environmentLabel ?? "environment").replace(/[^A-Za-z0-9._-]/g, "_")}.env`;
