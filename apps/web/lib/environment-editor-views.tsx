import type {
  PublicationContext,
  RevisionSigningTrust,
  SyncPageWire,
} from "@dotrelay/client";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type ConflictChangeKind,
  type ConflictResolution,
  type ConflictSummary,
  type EnvironmentVariable,
  revisionMutationLabel,
  splitInlineValueDiff,
  type VariableDraft,
  type VariableValueDiff,
  type VerifiedRevision,
  verifiedRevisionFromWire,
} from "@/lib/environment-workflow";

// Display building blocks for the Environment editor: revision and diff
// labels, conflict comparison surfaces, the variable row, and the
// add-variable dialog. Presentation only: every value and action arrives
// through props.

export type AddVariableState = VariableDraft;

type SessionSigningTrustSource = Readonly<{
  readonly context: PublicationContext;
  readonly signingTrustKeys?: RevisionSigningTrust;
}>;

export const ownershipLabel = (
  ownership: EnvironmentVariable["ownership"],
): string =>
  ownership === "SHARED_VALUE" ? "Shared value" : "User-defined value";

export const sessionSigningTrust = (
  session: SessionSigningTrustSource,
): RevisionSigningTrust => {
  if (session.signingTrustKeys && session.signingTrustKeys.length > 0)
    return session.signingTrustKeys;
  if (!session.context.revisionSigningPublicKey)
    throw new Error("revision signing trust key is unavailable");
  return session.context.revisionSigningPublicKey;
};

export const headFromContext = (
  context: PublicationContext | undefined,
): Readonly<{ readonly id: string; readonly hash: Uint8Array }> | null =>
  context?.expectedHeadId && context.expectedHeadHash
    ? {
        id: context.expectedHeadId,
        hash: context.expectedHeadHash,
      }
    : null;

export const nextVariableId = (): string => globalThis.crypto.randomUUID();

export const revisionNumber = (revision: string): number =>
  Number.parseInt(revision.replace("rev_", ""), 10);

export const valueStateLabel = (variable: EnvironmentVariable): string => {
  if (variable.tombstone) return "Will delete";
  if (variable.value === null) return "Not set";
  return "Hidden";
};

export const formatDiffValue = (
  value: string | null | undefined,
  revealed: boolean,
): string | null => {
  if (value === undefined) return null;
  if (value === null) return "not set";
  if (value === "") return "empty";
  return revealed ? value : "••••••••";
};

export const displayRevisionId = (id: string): string =>
  id.startsWith("rev_") ? id : id.slice(-8);

export const revisionTimeLabel = (authoredAtMs: number | null): string =>
  authoredAtMs === null
    ? "Time unavailable"
    : new Date(authoredAtMs).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });

export const revisionAuthorLabel = (
  revision: VerifiedRevision,
  actorUserId: string | undefined,
): string =>
  revision.authorUserId !== null &&
  actorUserId !== undefined &&
  revision.authorUserId === actorUserId
    ? "You"
    : "Author unavailable";

export const verifiedRevisionsFromPage = (
  page: SyncPageWire,
): readonly VerifiedRevision[] =>
  page.revisions.map((revision) => verifiedRevisionFromWire(revision));

export const RevisionIdentity = ({
  revision,
  actorUserId,
  idClassName = "font-mono text-sm",
  lineSuffix = null,
}: Readonly<{
  readonly revision: VerifiedRevision;
  readonly actorUserId: string | undefined;
  readonly idClassName?: string;
  readonly lineSuffix?: ReactNode;
}>) => {
  const mutationLabel = revisionMutationLabel(revision.mutation);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={idClassName}>{displayRevisionId(revision.id)}</span>
        {mutationLabel ? (
          <Badge
            className="h-4 text-[10px] font-medium uppercase tracking-wide"
            variant="secondary"
          >
            {mutationLabel}
          </Badge>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        <span>{revisionTimeLabel(revision.authoredAtMs)}</span> ·{" "}
        <span>{revisionAuthorLabel(revision, actorUserId)}</span>
        {lineSuffix}
      </p>
    </>
  );
};

export const InlineHunk = ({
  hunk,
  side,
}: {
  readonly hunk: ReturnType<typeof splitInlineValueDiff>;
  readonly side: "from" | "to";
}) => {
  const changed = side === "from" ? hunk.removed : hunk.added;
  return (
    <span className="break-all">
      {hunk.prefix ? (
        <span className="text-muted-foreground">{hunk.prefix}</span>
      ) : null}
      {changed ? (
        <span className={side === "from" ? "text-red-300" : "text-emerald-300"}>
          {changed}
        </span>
      ) : null}
      {hunk.suffix ? (
        <span className="text-muted-foreground">{hunk.suffix}</span>
      ) : null}
    </span>
  );
};

export const ValueDiffLines = ({
  diff,
  revealed,
}: {
  readonly diff: VariableValueDiff;
  readonly revealed: boolean;
}) => {
  const bothStrings =
    typeof diff.from === "string" && typeof diff.to === "string";
  if (bothStrings && revealed) {
    const hunk = splitInlineValueDiff(diff.from, diff.to);
    const showFrom = hunk.removed.length > 0;
    const showTo = hunk.added.length > 0 || !showFrom;
    return (
      <div className="min-w-0 font-mono text-sm leading-5">
        <p className="break-all font-medium text-foreground">{diff.name}</p>
        {showFrom ? (
          <p>
            {showTo ? <span className="text-muted-foreground">- </span> : null}
            <InlineHunk hunk={hunk} side="from" />
          </p>
        ) : null}
        {showTo ? (
          <p>
            {showFrom ? (
              <span className="text-muted-foreground">+ </span>
            ) : null}
            <InlineHunk hunk={hunk} side="to" />
          </p>
        ) : null}
      </div>
    );
  }

  const from = formatDiffValue(diff.from, revealed);
  const to = formatDiffValue(diff.to, revealed);
  return (
    <div className="min-w-0 font-mono text-sm leading-5">
      <p className="break-all font-medium text-foreground">{diff.name}</p>
      {from ? (
        <p className="break-all text-red-300/90" title={from}>
          - {from}
        </p>
      ) : null}
      {to ? (
        <p className="break-all text-emerald-300/90" title={to}>
          + {to}
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">Will be deleted</p>
      )}
    </div>
  );
};

export const conflictKindLabel = (kind: ConflictChangeKind): string =>
  kind === "value" ? "Value" : kind === "definition" ? "Settings" : "Deletion";
export const resolutionLabel = (choice: ConflictResolution): string =>
  choice === "local"
    ? "Keep mine"
    : choice === "remote"
      ? "Use theirs"
      : "Keep my value";

export const resolutionConsequence = (
  choice: ConflictResolution | null,
): string => {
  if (choice === null)
    return "Compare both versions, then choose what to keep for this variable.";
  if (choice === "local")
    return "Keep your version of this variable, including its value. Discard their changes.";
  if (choice === "remote")
    return "Use their version of this variable, including its value. Discard your changes.";
  return "Keep your value. Use their name, description, sharing setting, and value requirement.";
};

export const MaskedValue = ({
  value,
  revealed,
}: {
  readonly value: string | null;
  readonly revealed: boolean;
}) => (
  <span className="break-all font-mono text-sm">
    {formatDiffValue(value, revealed) ?? "—"}
  </span>
);

export const ConflictSides = ({
  local,
  remote,
  revealed,
}: {
  readonly local: EnvironmentVariable;
  readonly remote: EnvironmentVariable | null;
  readonly revealed: boolean;
}) => {
  if (local.tombstone || remote?.tombstone) {
    return (
      <div className="grid gap-1 text-xs">
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Yours</span>{" "}
          {local.tombstone ? "was deleted" : "still has this variable"}
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Theirs</span>{" "}
          {remote
            ? remote.tombstone
              ? "deleted it"
              : "still has it"
            : "could not be read"}
        </p>
      </div>
    );
  }
  const localValue = local.value;
  const remoteValue = remote?.value ?? null;
  const bothStrings =
    typeof localValue === "string" && typeof remoteValue === "string";
  if (bothStrings && revealed && localValue !== remoteValue) {
    const hunk = splitInlineValueDiff(remoteValue, localValue);
    const showFrom = hunk.removed.length > 0;
    const showTo = hunk.added.length > 0 || !showFrom;
    return (
      <div className="min-w-0 font-mono text-sm leading-5">
        <div className="flex gap-2">
          <span className="w-14 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
            Theirs
          </span>
          <span className={showFrom ? "text-red-300/90" : undefined}>
            {showFrom ? <InlineHunk hunk={hunk} side="from" /> : remoteValue}
          </span>
        </div>
        <div className="flex gap-2">
          <span className="w-14 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
            Yours
          </span>
          <span className={showTo ? "text-emerald-300/90" : undefined}>
            {showTo ? <InlineHunk hunk={hunk} side="to" /> : localValue}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      <div className="flex gap-2">
        <span className="w-14 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
          Theirs
        </span>
        <MaskedValue value={remoteValue} revealed={revealed} />
      </div>
      <div className="flex gap-2">
        <span className="w-14 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
          Yours
        </span>
        <MaskedValue value={localValue} revealed={revealed} />
      </div>
    </div>
  );
};

export const ConflictDefinitionLines = ({
  local,
  remote,
}: {
  readonly local: EnvironmentVariable;
  readonly remote: EnvironmentVariable;
}) => {
  const lines: string[] = [];
  if (local.ownership !== remote.ownership)
    lines.push(
      `Sharing: yours is ${ownershipLabel(local.ownership).toLowerCase()}, theirs is ${ownershipLabel(remote.ownership).toLowerCase()}`,
    );
  if (local.description !== remote.description)
    lines.push(
      `Description: yours "${local.description || "none"}", theirs "${remote.description || "none"}"`,
    );
  if (local.required !== remote.required)
    lines.push(
      `Required: yours ${local.required ? "yes" : "no"}, theirs ${remote.required ? "yes" : "no"}`,
    );
  if (lines.length === 0) return null;
  return (
    <div className="grid gap-0.5 text-xs text-muted-foreground">
      <p className="text-[11px] uppercase tracking-wide">Other settings</p>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
};

export const ConflictLane = ({
  summary,
  choice,
  revealed,
  onChoose,
  onRevisit,
}: {
  readonly summary: ConflictSummary;
  readonly choice: ConflictResolution | null;
  readonly revealed: boolean;
  readonly onChoose: (choice: ConflictResolution) => void;
  readonly onRevisit: () => void;
}) => {
  const { local, remote, kinds } = summary;
  const remoteAvailable = remote !== null;
  const canMerge = remoteAvailable && !local.tombstone;
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all font-mono text-sm font-medium">
          {summary.name}
        </span>
        {kinds.map((kind) => (
          <Badge
            className="h-4 text-[10px] font-medium uppercase tracking-wide"
            key={kind}
            variant="secondary"
          >
            {conflictKindLabel(kind)}
          </Badge>
        ))}
        {!remoteAvailable ? (
          <Badge
            className="h-4 text-[10px] font-medium uppercase tracking-wide"
            variant="outline"
          >
            Their version unavailable
          </Badge>
        ) : null}
      </div>
      {remoteAvailable && remote ? (
        <div className="grid gap-2">
          <ConflictSides local={local} remote={remote} revealed={revealed} />
          <ConflictDefinitionLines local={local} remote={remote} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          We couldn't read their version, so only your change is shown. You can
          still keep your change, or retry reading to compare both sides.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => onChoose("local")}
          size="sm"
          variant={choice === "local" ? "default" : "outline"}
        >
          Keep mine
        </Button>
        <Button
          disabled={!remoteAvailable}
          onClick={() => onChoose("remote")}
          size="sm"
          variant={choice === "remote" ? "default" : "outline"}
        >
          Use theirs
        </Button>
        <Button
          disabled={!canMerge}
          onClick={() => onChoose("merge")}
          size="sm"
          variant={choice === "merge" ? "default" : "outline"}
        >
          Keep my value
        </Button>
        {choice ? (
          <>
            <span className="text-xs text-emerald-300">
              {resolutionLabel(choice)}
            </span>
            <Button onClick={onRevisit} size="xs" variant="ghost">
              Change
            </Button>
          </>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {resolutionConsequence(choice)}
      </p>
    </div>
  );
};

export const VariableRow = ({
  variable,
  revealed,
  editingDisabled,
  canEdit,
  canDelete,
  readOnlyDisclosure,
  canUndoDelete,
  onDelete,
  onSetAbsent,
  onToggleReveal,
  onUndoDelete,
  onValueChange,
}: {
  readonly variable: EnvironmentVariable;
  readonly revealed: boolean;
  readonly editingDisabled: boolean;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly readOnlyDisclosure: string | null;
  readonly canUndoDelete: boolean;
  readonly onDelete: () => void;
  readonly onSetAbsent: () => void;
  readonly onToggleReveal: () => void;
  readonly onUndoDelete: () => void;
  readonly onValueChange: (value: string) => void;
}) => {
  const state = valueStateLabel(variable);
  const showState = state !== "Hidden";

  return (
    <li
      className="px-4 py-1.5 hover:bg-muted/20"
      data-testid={`environment-variable-${variable.name}`}
    >
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0 sm:w-[min(22rem,36%)] sm:shrink-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="min-w-0 flex-1 break-all font-mono text-sm font-medium tracking-tight">
              {variable.name}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {ownershipLabel(variable.ownership)}
            </span>
            {readOnlyDisclosure ? (
              <span
                className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
                title={readOnlyDisclosure}
              >
                Read-only
              </span>
            ) : null}
            {variable.hasDraftChange ? (
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-amber-200">
                Draft change
              </span>
            ) : null}
          </div>
          {variable.description ? (
            <p className="break-words text-xs leading-5 text-muted-foreground/80">
              {variable.description}
            </p>
          ) : null}
        </div>

        {variable.tombstone ? (
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              This variable is marked for deletion.
            </span>
            {variable.hasDraftChange && canUndoDelete ? (
              <Button
                disabled={editingDisabled || !canDelete}
                onClick={onUndoDelete}
                size="xs"
                variant="outline"
              >
                Undo delete
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Label className="sr-only" htmlFor={`value-${variable.id}`}>
              {variable.name} value
            </Label>
            <Input
              aria-readonly={!canEdit}
              autoComplete="off"
              className="font-mono"
              disabled={editingDisabled || !canEdit}
              id={`value-${variable.id}`}
              onChange={(event) => onValueChange(event.target.value)}
              placeholder={variable.value === null ? "Not set" : "Empty value"}
              type={revealed ? "text" : "password"}
              value={variable.value ?? ""}
            />
            {showState ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {state}
              </span>
            ) : null}
            <Button
              aria-label={`${revealed ? "Hide" : "Reveal"} ${variable.name}`}
              disabled={editingDisabled}
              onClick={onToggleReveal}
              size="icon-sm"
              variant="ghost"
            >
              {revealed ? (
                <EyeOff aria-hidden="true" />
              ) : (
                <Eye aria-hidden="true" />
              )}
            </Button>
            {!variable.required && variable.value !== null ? (
              <Button
                disabled={editingDisabled || !canEdit}
                onClick={onSetAbsent}
                size="xs"
                variant="ghost"
              >
                Unset value
              </Button>
            ) : null}
            <Button
              aria-label={`Delete ${variable.name}`}
              className="text-muted-foreground hover:text-destructive"
              disabled={editingDisabled || !canDelete}
              onClick={onDelete}
              size="icon-sm"
              variant="ghost"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
    </li>
  );
};

export const AddVariableDialog = ({
  open,
  draft,
  error,
  onOpenChange,
  onDraftChange,
  onCreate,
}: {
  readonly open: boolean;
  readonly draft: AddVariableState;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDraftChange: (draft: AddVariableState) => void;
  readonly onCreate: () => void;
}) => {
  // The value field is masked by default; the toggle mirrors the reveal
  // affordance on each variable row so a value typed here can be checked
  // before the variable is added to the draft.
  const [valueRevealed, setValueRevealed] = useState(false);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add variable</DialogTitle>
          <DialogDescription>
            Choose who can read the value. Add it to your draft before
            publishing.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="new-variable-name">Variable name</Label>
            <Input
              autoComplete="off"
              id="new-variable-name"
              onChange={(event) =>
                onDraftChange({ ...draft, name: event.target.value })
              }
              placeholder="DATABASE_URL"
              value={draft.name}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-variable-description">
              Description{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <textarea
              className="min-h-20 rounded-lg border border-input bg-input/20 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id="new-variable-description"
              onChange={(event) =>
                onDraftChange({ ...draft, description: event.target.value })
              }
              placeholder="What this variable is used for"
              value={draft.description}
            />
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">
              Who can read the value
            </legend>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5">
              <input
                checked={draft.ownership === "SHARED_VALUE"}
                name="new-variable-ownership"
                onChange={() =>
                  onDraftChange({ ...draft, ownership: "SHARED_VALUE" })
                }
                type="radio"
              />
              <span>
                <span className="block text-sm font-medium">Shared value</span>
                <span className="block text-xs text-muted-foreground">
                  Teammates with project keys can read it. You, owners, and
                  admins can edit it.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5">
              <input
                checked={draft.ownership === "USER_DEFINED_VALUE"}
                name="new-variable-ownership"
                onChange={() =>
                  onDraftChange({ ...draft, ownership: "USER_DEFINED_VALUE" })
                }
                type="radio"
              />
              <span>
                <span className="block text-sm font-medium">
                  User-defined value
                </span>
                <span className="block text-xs text-muted-foreground">
                  Only the devices you have set up can read it.
                </span>
              </span>
            </label>
          </fieldset>
          <div className="grid gap-2">
            <Label htmlFor="new-variable-value">Initial value</Label>
            <div className="flex items-center gap-2">
              <Input
                autoComplete="off"
                className="font-mono"
                id="new-variable-value"
                onChange={(event) =>
                  onDraftChange({ ...draft, value: event.target.value })
                }
                placeholder="Leave blank to save an empty string"
                type={valueRevealed ? "text" : "password"}
                value={draft.value}
              />
              <Button
                aria-label={`${valueRevealed ? "Hide" : "Reveal"} initial value`}
                aria-pressed={valueRevealed}
                data-testid="add-variable-reveal"
                onClick={() => setValueRevealed((current) => !current)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {valueRevealed ? (
                  <EyeOff aria-hidden="true" />
                ) : (
                  <Eye aria-hidden="true" />
                )}
              </Button>
            </div>
          </div>
          {!draft.required ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                checked={draft.valuePresent === false}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    valuePresent: !event.target.checked,
                  })
                }
                type="checkbox"
              />
              Leave the value unset, rather than save an empty string
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              checked={draft.required}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  required: event.target.checked,
                  ...(event.target.checked ? { valuePresent: true } : {}),
                })
              }
              type="checkbox"
            />
            Require a value
          </label>
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button onClick={onCreate}>
            <Plus aria-hidden="true" /> Add variable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
