import {
  ownSigningTrust,
  type PublicationContext,
  type RevisionSigningTrust,
  type SyncPageWire,
} from "@dotrelay/client";
import { Check, Copy, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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
import { SecretValueInput } from "@/components/secret-value-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
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
): string => (ownership === "SHARED_VALUE" ? "Team" : "Only me");

// The history signers a session verifies Revisions against. Without
// roster-verified entries only this browser's own key counts, bound to its
// own User and Device (ADR 0023).
export const sessionSigningTrust = (
  session: SessionSigningTrustSource,
): RevisionSigningTrust => {
  if (session.signingTrustKeys && session.signingTrustKeys.length > 0)
    return session.signingTrustKeys;
  const own = ownSigningTrust(session.context);
  if (own.length === 0)
    throw new Error("revision signing trust key is unavailable");
  return own;
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

// Display names of the Team's members by User id, from the membership
// record the workspace already loaded.
export type MemberNames = ReadonlyMap<string, string>;

export const revisionAuthorLabel = (
  revision: VerifiedRevision,
  actorUserId: string | undefined,
  memberNames: MemberNames = new Map(),
): string => {
  if (revision.authorUserId === null) return "Author unavailable";
  if (actorUserId !== undefined && revision.authorUserId === actorUserId)
    return "You";
  return memberNames.get(revision.authorUserId) ?? "Unknown member";
};

// "Changed A, B and 3 more", naming Variables by their current names. Lanes
// whose Variable is not in the current list are counted, not named.
export const revisionChangesLabel = (
  revision: VerifiedRevision,
  variableNames: ReadonlyMap<string, string>,
  shown = 3,
): string | null => {
  const ids = revision.changedVariableIds;
  if (ids === null || ids.length === 0) return null;
  const names = ids
    .map((id) => variableNames.get(id))
    .filter((name): name is string => name !== undefined);
  const listed = names.slice(0, shown);
  const rest = ids.length - listed.length;
  if (listed.length === 0)
    return `Changed ${ids.length} variable${ids.length === 1 ? "" : "s"}`;
  return `Changed ${listed.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
};

export const verifiedRevisionsFromPage = (
  page: SyncPageWire,
): readonly VerifiedRevision[] =>
  page.revisions.map((revision) => verifiedRevisionFromWire(revision));

export const RevisionIdentity = ({
  revision,
  actorUserId,
  memberNames,
  variableNames,
  idClassName = "font-mono text-sm",
  lineSuffix = null,
}: Readonly<{
  readonly revision: VerifiedRevision;
  readonly actorUserId: string | undefined;
  readonly memberNames?: MemberNames | undefined;
  readonly variableNames?: ReadonlyMap<string, string> | undefined;
  readonly idClassName?: string;
  readonly lineSuffix?: ReactNode;
}>) => {
  const mutationLabel = revisionMutationLabel(revision.mutation);
  const changes = variableNames
    ? revisionChangesLabel(revision, variableNames)
    : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={idClassName}>{displayRevisionId(revision.id)}</span>
        {mutationLabel ? (
          <Badge className="h-4 text-[10px] font-medium" variant="secondary">
            {mutationLabel}
          </Badge>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        <span>{revisionTimeLabel(revision.authoredAtMs)}</span> ·{" "}
        <span>{revisionAuthorLabel(revision, actorUserId, memberNames)}</span>
        {lineSuffix}
      </p>
      {changes ? (
        <p className="break-all font-mono text-[11px] text-muted-foreground">
          {changes}
        </p>
      ) : null}
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
          <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
            Theirs
          </span>
          <span className={showFrom ? "text-red-300/90" : undefined}>
            {showFrom ? <InlineHunk hunk={hunk} side="from" /> : remoteValue}
          </span>
        </div>
        <div className="flex gap-2">
          <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
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
        <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
          Theirs
        </span>
        <MaskedValue value={remoteValue} revealed={revealed} />
      </div>
      <div className="flex gap-2">
        <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
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
      `Visible to: yours is “${ownershipLabel(local.ownership)}”, theirs is “${ownershipLabel(remote.ownership)}”`,
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
      <p className="text-[11px]">Other settings</p>
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
            className="h-4 text-[10px] font-medium"
            key={kind}
            variant="secondary"
          >
            {conflictKindLabel(kind)}
          </Badge>
        ))}
        {!remoteAvailable ? (
          <Badge className="h-4 text-[10px] font-medium" variant="outline">
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

// Copies a readable value without rendering it: the value goes straight to
// the clipboard, and the button confirms in place for a moment.
const CopyValueButton = ({
  name,
  value,
  disabled,
}: Readonly<{
  readonly name: string;
  readonly value: string;
  readonly disabled: boolean;
}>) => {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timeout = window.setTimeout(() => setState("idle"), 1500);
    return () => window.clearTimeout(timeout);
  }, [state]);
  return (
    <>
      <Button
        aria-label={`Copy ${name}`}
        disabled={disabled}
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => setState("copied"))
            .catch(() => setState("failed"));
        }}
        size="icon-sm"
        title={state === "failed" ? "Couldn't copy" : `Copy ${name}`}
        variant="ghost"
      >
        {state === "copied" ? (
          <Check aria-hidden="true" className="text-primary" />
        ) : (
          <Copy aria-hidden="true" />
        )}
      </Button>
      <span aria-live="polite" className="sr-only">
        {state === "copied"
          ? `Copied ${name}`
          : state === "failed"
            ? `Couldn't copy ${name}`
            : ""}
      </span>
    </>
  );
};

export const VariableRow = ({
  variable,
  revealed,
  editingDisabled,
  canEdit,
  canDelete,
  readOnlyDisclosure,
  othersPrivate,
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
  /**
   * Another member's "Only me" Value, which never reaches this browser:
   * there is nothing to reveal, and "Not set" would suggest it is empty.
   */
  readonly othersPrivate: boolean;
  readonly canUndoDelete: boolean;
  readonly onDelete: () => void;
  readonly onSetAbsent: () => void;
  readonly onToggleReveal: () => void;
  readonly onUndoDelete: () => void;
  readonly onValueChange: (value: string) => void;
}) => {
  const state = othersPrivate ? "Private" : valueStateLabel(variable);
  const showState = state !== "Hidden";

  return (
    <li
      className={cn(
        "relative grid gap-2 px-4 py-2.5 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_6rem] md:items-center md:gap-3",
        variable.hasDraftChange
          ? "bg-amber-300/[0.06] before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-amber-300"
          : "hover:bg-muted/20",
      )}
      data-testid={`environment-variable-${variable.name}`}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 break-all font-mono text-[13px] font-medium">
            {variable.name}
          </span>
          {variable.hasDraftChange ? (
            <span className="shrink-0 text-xs text-amber-200">
              {variable.tombstone ? "Will be removed" : "Not published"}
            </span>
          ) : null}
          {readOnlyDisclosure ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              Read-only
            </span>
          ) : null}
        </div>
        {variable.description ? (
          <p className="break-words text-xs leading-5 text-muted-foreground">
            {variable.description}
          </p>
        ) : null}
        {readOnlyDisclosure ? (
          <p
            className="break-words text-xs leading-4 text-muted-foreground"
            id={`read-only-${variable.id}`}
          >
            {readOnlyDisclosure}
          </p>
        ) : null}
      </div>

      {variable.tombstone ? (
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            Removed in your changes.
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
        <div className="flex min-w-0 items-center gap-1">
          <Label className="sr-only" htmlFor={`value-${variable.id}`}>
            {variable.name} value
          </Label>
          <SecretValueInput
            aria-describedby={
              readOnlyDisclosure ? `read-only-${variable.id}` : undefined
            }
            autoCapitalize="off"
            autoComplete="new-password"
            autoCorrect="off"
            className="h-8 min-w-0 flex-1 border-transparent bg-transparent font-mono text-[13px] hover:border-input focus-visible:border-ring read-only:hover:border-transparent dark:bg-transparent"
            data-1p-ignore
            data-lpignore="true"
            disabled={editingDisabled}
            id={`value-${variable.id}`}
            masked={!revealed}
            readOnly={!canEdit}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={variable.value === null ? "" : "Empty"}
            spellCheck={false}
            type={revealed ? "text" : "password"}
            value={variable.value ?? ""}
          />
          {showState ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {state}
            </span>
          ) : null}
          {othersPrivate ? null : (
            <Button
              aria-label={`${revealed ? "Hide" : "Reveal"} ${variable.name}`}
              disabled={editingDisabled}
              onClick={onToggleReveal}
              size="icon-sm"
              title={revealed ? "Hide value" : "Show value"}
              variant="ghost"
            >
              {revealed ? (
                <EyeOff aria-hidden="true" />
              ) : (
                <Eye aria-hidden="true" />
              )}
            </Button>
          )}
          {variable.value !== null ? (
            <CopyValueButton
              disabled={editingDisabled}
              name={variable.name}
              value={variable.value}
            />
          ) : null}
          {!variable.required && variable.value !== null && canEdit ? (
            <Button
              disabled={editingDisabled}
              onClick={onSetAbsent}
              size="xs"
              title="Remove the value but keep the variable"
              variant="ghost"
            >
              Unset value
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              aria-label={`Delete ${variable.name}`}
              className="text-muted-foreground hover:text-destructive"
              disabled={editingDisabled}
              onClick={onDelete}
              size="icon-sm"
              title="Delete variable"
              variant="ghost"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      )}
      <div className="md:order-none">
        <Badge
          className={cn(
            "font-normal",
            variable.ownership === "SHARED_VALUE"
              ? "text-muted-foreground"
              : "border-violet-300/30 bg-violet-300/10 text-violet-200",
          )}
          variant="outline"
        >
          {ownershipLabel(variable.ownership)}
        </Badge>
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
            It&apos;s added to your unpublished changes. Publish to share it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="new-variable-name">Name</Label>
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
            <legend className="text-sm font-medium">Visible to</legend>
            <label
              aria-label="Team"
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5"
            >
              <input
                checked={draft.ownership === "SHARED_VALUE"}
                name="new-variable-ownership"
                onChange={() =>
                  onDraftChange({ ...draft, ownership: "SHARED_VALUE" })
                }
                type="radio"
              />
              <span>
                <span className="block text-sm font-medium">Team</span>
                <span className="block text-xs text-muted-foreground">
                  Everyone on the team sees the same value. You, owners and
                  admins can change it.
                </span>
              </span>
            </label>
            <label
              aria-label="Only me"
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5"
            >
              <input
                checked={draft.ownership === "USER_DEFINED_VALUE"}
                name="new-variable-ownership"
                onChange={() =>
                  onDraftChange({ ...draft, ownership: "USER_DEFINED_VALUE" })
                }
                type="radio"
              />
              <span>
                <span className="block text-sm font-medium">Only me</span>
                <span className="block text-xs text-muted-foreground">
                  Private to you. Only your devices can read it; teammates
                  don&apos;t get it.
                </span>
              </span>
            </label>
          </fieldset>
          <div className="grid gap-2">
            <Label htmlFor="new-variable-value">Value</Label>
            <div className="flex items-center gap-2">
              <SecretValueInput
                autoCapitalize="off"
                autoComplete="new-password"
                autoCorrect="off"
                className="font-mono"
                data-1p-ignore
                data-lpignore="true"
                id="new-variable-value"
                onChange={(event) =>
                  onDraftChange({ ...draft, value: event.target.value })
                }
                placeholder="Leave blank for an empty value"
                spellCheck={false}
                type={valueRevealed ? "text" : "password"}
                value={draft.value}
              />
              <Button
                aria-label={`${valueRevealed ? "Hide" : "Reveal"} value`}
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
              Leave it unset instead of empty
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
