"use client";

import {
  changedVariableIdsFromSyncPage,
  createPublicationArtifacts,
  type ProtocolTransport,
  ProtocolTransportError,
  type PublicationContext,
  type RevisionSigningTrust,
  type SyncPageWire,
  sha384,
  UnreadableLaneError,
  verifySyncPage,
} from "@dotrelay/client";
import {
  Check,
  Eye,
  EyeOff,
  GitBranch,
  List,
  LockKeyhole,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CopyableCommand } from "@/components/copyable-command";
import { CommandText } from "@/components/inline-command";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  type EnvironmentContextIdentity,
  environmentContextKey,
  sessionMatchesContext,
} from "@/lib/environment-context";
import {
  applyConflictResolution,
  applyRollbackToVariables,
  bareVerifiedRevision,
  type ConflictChangeKind,
  type ConflictResolution,
  type ConflictSummary,
  canActorChangeDefinitions,
  canActorChangeVariableValue,
  canActorPublishVariable,
  changedLaneCount,
  createEnvironmentVariable,
  createRollbackPlan,
  deleteEnvironmentVariable,
  draftValueDiffs,
  type EditorActor,
  type EnvironmentVariable,
  loadRollbackHistory,
  locallyPublishedRevision,
  mergeDraftVariablesOverRemote,
  mergeVerifiedHistory,
  prepareEncryptedPublication,
  publicationMutationForHead,
  publishedBaseline,
  type RollbackHistoryResolution,
  readOnlyReason,
  reconcileDraftWithPermissions,
  revisionMutationLabel,
  roleLabel,
  rollbackValueDiffs,
  type SetupAction,
  settlePublishedDraft,
  splitInlineValueDiff,
  summarizeConflict,
  updateVariableValue,
  type VariableDraft,
  type VariableValueDiff,
  type VerifiedRevision,
  validateVariableDraft,
  variableHasDraftChange,
  verifiedRevisionFromWire,
} from "@/lib/environment-workflow";
import type { MembershipRole } from "@/lib/workspace-boundary";

type EnvironmentEditorProps = Readonly<{
  readonly available: boolean;
  readonly active?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly contextIdentity: EnvironmentContextIdentity;
  readonly role: MembershipRole;
  readonly onDraftDirtyChange?: (
    dirty: boolean,
    changedVariableNames: readonly string[],
  ) => void;
  readonly setupAction?: SetupAction | null | undefined;
  readonly setupCommand?: string | undefined;
  readonly setupMessage?: string | null | undefined;
  readonly setupBusy?: boolean | undefined;
  readonly onSetupAction?: (() => void) | undefined;
  readonly protocolSession?:
    | Readonly<{
        readonly context: PublicationContext;
        readonly transport: ProtocolTransport;
        readonly signingTrustKeys?: RevisionSigningTrust;
        readonly decodeVariables?: (
          page: SyncPageWire,
          previousVariables: readonly EnvironmentVariable[],
        ) => Promise<readonly EnvironmentVariable[]>;
        readonly resolveRollbackValues?: (input: {
          readonly targetRevision: string;
          readonly selectedVariableIds: readonly string[];
        }) => Promise<ReadonlyMap<string, string | null>>;
      }>
    | undefined;
}>;

type AddVariableState = VariableDraft;

const initialVariables: readonly EnvironmentVariable[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "API_ORIGIN",
    description: "Shared service origin used by the team.",
    ownership: "SHARED_VALUE",
    value: "",
    required: true,
    hasDraftChange: false,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "SIGNING_KEY",
    description: "Your own signing material for this browser.",
    ownership: "USER_DEFINED_VALUE",
    value: "",
    required: true,
    hasDraftChange: false,
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    name: "FEATURE_GATE",
    description: "Optional team feature flag.",
    ownership: "SHARED_VALUE",
    value: null,
    required: false,
    hasDraftChange: false,
  },
];

const emptyVariableDraft: AddVariableState = {
  name: "",
  description: "",
  ownership: "",
  value: "",
  valuePresent: true,
  required: true,
};

const ownershipLabel = (ownership: EnvironmentVariable["ownership"]): string =>
  ownership === "SHARED_VALUE" ? "Shared value" : "User-defined value";

const sessionSigningTrust = (
  session: NonNullable<EnvironmentEditorProps["protocolSession"]>,
): RevisionSigningTrust => {
  if (session.signingTrustKeys && session.signingTrustKeys.length > 0)
    return session.signingTrustKeys;
  if (!session.context.revisionSigningPublicKey)
    throw new Error("revision signing trust key is unavailable");
  return session.context.revisionSigningPublicKey;
};

const headFromContext = (
  context: PublicationContext | undefined,
): Readonly<{ readonly id: string; readonly hash: Uint8Array }> | null =>
  context?.expectedHeadId && context.expectedHeadHash
    ? {
        id: context.expectedHeadId,
        hash: context.expectedHeadHash,
      }
    : null;

const nextVariableId = (): string => globalThis.crypto.randomUUID();

const revisionNumber = (revision: string): number =>
  Number.parseInt(revision.replace("rev_", ""), 10);

const valueStateLabel = (variable: EnvironmentVariable): string => {
  if (variable.tombstone) return "Will delete";
  if (variable.value === null) return "Not set";
  return "Hidden";
};

const formatDiffValue = (
  value: string | null | undefined,
  revealed: boolean,
): string | null => {
  if (value === undefined) return null;
  if (value === null) return "not set";
  if (value === "") return "empty";
  return revealed ? value : "••••••••";
};

const displayRevisionId = (id: string): string =>
  id.startsWith("rev_") ? id : id.slice(-8);

const revisionTimeLabel = (authoredAtMs: number | null): string =>
  authoredAtMs === null
    ? "Time unavailable"
    : new Date(authoredAtMs).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });

const revisionAuthorLabel = (
  revision: VerifiedRevision,
  actorUserId: string | undefined,
): string =>
  revision.authorUserId !== null &&
  actorUserId !== undefined &&
  revision.authorUserId === actorUserId
    ? "You"
    : "Author unavailable";

const verifiedRevisionsFromPage = (
  page: SyncPageWire,
): readonly VerifiedRevision[] =>
  page.revisions.map((revision) => verifiedRevisionFromWire(revision));

const RevisionIdentity = ({
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

const InlineHunk = ({
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

const ValueDiffLines = ({
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

const conflictKindLabel = (kind: ConflictChangeKind): string =>
  kind === "value" ? "Value" : kind === "definition" ? "Settings" : "Deletion";
const resolutionLabel = (choice: ConflictResolution): string =>
  choice === "local"
    ? "Keep mine"
    : choice === "remote"
      ? "Use theirs"
      : "Keep my value";

const resolutionConsequence = (choice: ConflictResolution | null): string => {
  if (choice === null)
    return "Compare both versions, then choose what to keep for this variable.";
  if (choice === "local")
    return "Keep your version of this variable, including its value. Discard their changes.";
  if (choice === "remote")
    return "Use their version of this variable, including its value. Discard your changes.";
  return "Keep your value. Use their name, description, sharing setting, and value requirement.";
};

const MaskedValue = ({
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

const ConflictSides = ({
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

const ConflictDefinitionLines = ({
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

const ConflictLane = ({
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

const VariableRow = ({
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

const AddVariableDialog = ({
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

export const EnvironmentEditor = ({
  available,
  active,
  loading,
  contextIdentity,
  role,
  onDraftDirtyChange,
  setupAction,
  setupCommand,
  setupMessage,
  setupBusy,
  onSetupAction,
  protocolSession,
}: EnvironmentEditorProps) => {
  const session =
    protocolSession &&
    sessionMatchesContext(protocolSession.context, contextIdentity)
      ? protocolSession
      : null;
  const actorUserId = session?.context.actorUserId ?? null;
  const actor: EditorActor = { role, actorUserId };
  const canChangeDefinitions = canActorChangeDefinitions(actor);
  const [variables, setVariables] = useState<EnvironmentVariable[]>(() =>
    session ? [] : [...initialVariables],
  );
  const [remoteVariables, setRemoteVariables] = useState<
    readonly EnvironmentVariable[]
  >(() => (session ? [] : initialVariables));
  const [headRevision, setHeadRevision] = useState(
    session?.context.expectedHeadId ?? "rev_0184",
  );
  const [loadPhase, setLoadPhase] = useState<"loading" | "ready" | "failed">(
    () => (session ? "loading" : "ready"),
  );
  const [verifiedHistory, setVerifiedHistory] = useState<
    readonly VerifiedRevision[]
  >([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] =
    useState<AddVariableState>(emptyVariableDraft);
  const [addError, setAddError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);
  const [rollbackLanes, setRollbackLanes] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [conflictLaneIds, setConflictLaneIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [conflictChoices, setConflictChoices] = useState<
    ReadonlyMap<string, ConflictResolution>
  >(() => new Map());
  const [conflictValuesRevealed, setConflictValuesRevealed] = useState(false);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [staleHeadRevision, setStaleHeadRevision] = useState<string | null>(
    null,
  );
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [protocolHead, setProtocolHead] = useState<Readonly<{
    readonly id: string;
    readonly hash: Uint8Array;
  }> | null>(() => headFromContext(session?.context));
  const [rollbackMutationTarget, setRollbackMutationTarget] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (!session) return;
    setVariables((current) =>
      current.some((variable) => variable.hasDraftChange) ? current : [],
    );
    setRemoteVariables([]);
    setHeadRevision(session.context.expectedHeadId ?? "empty-environment");
    setVerifiedHistory([]);
    setProtocolHead(headFromContext(session.context));
    setConflictLaneIds(new Set());
    setConflictChoices(new Map());
    setConflictValuesRevealed(false);
    setStaleHeadRevision(null);
    setLoadPhase("loading");
  }, [session]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt is a retry trigger whose value is intentionally not read inside the effect
  useEffect(() => {
    if (!session || !available) return;
    let cancelled = false;
    const load = async () => {
      setLoadPhase("loading");
      setAddOpen(false);
      try {
        const context = session.context;
        if (!context.trustedRevisionId || !context.trustedRevisionHash) {
          if (!cancelled) setLoadPhase("ready");
          return;
        }
        const page = await session.transport.syncAll({
          environmentId: context.environmentId,
          deviceId: context.actorDeviceId,
          request: {
            trustedRevisionId: context.trustedRevisionId,
            trustedRevisionHash: context.trustedRevisionHash,
            pagination: {},
          },
        });
        await verifySyncPage(page, sessionSigningTrust(session), {
          actorUserId: context.actorUserId,
        });
        if (cancelled) return;
        const decoded = session.decodeVariables
          ? await session.decodeVariables(page, [])
          : undefined;
        if (cancelled) return;
        if (!decoded) {
          setPublishMessage(
            "This browser couldn't read the current environment. Try reading it again.",
          );
          setLoadPhase("failed");
          return;
        }
        setRemoteVariables(decoded);
        setVariables((current) =>
          current.some((variable) => variable.hasDraftChange)
            ? [...mergeDraftVariablesOverRemote(current, decoded)]
            : [...decoded],
        );
        setVerifiedHistory((current) =>
          mergeVerifiedHistory(current, verifiedRevisionsFromPage(page)),
        );
        if (page.currentHeadId && page.currentHeadHash) {
          setProtocolHead({
            id: page.currentHeadId,
            hash: page.currentHeadHash,
          });
          setHeadRevision(page.currentHeadId);
        }
        if (!cancelled) setLoadPhase("ready");
      } catch (error) {
        if (!cancelled) {
          setPublishMessage(
            error instanceof UnreadableLaneError
              ? error.laneKind === "USER_DEFINED_VALUE"
                ? "This browser's keys can't read some of the environment's latest values. They were encrypted for the device that published them, and `dotrelay pull` can't re-share a User-defined Value. Re-publish the affected Values from that Device (or run dotrelay device recover for it), then use Retry reading."
                : "This browser's keys can't decrypt the environment's latest values. An owner or admin can re-share the Project's keys by running dotrelay pull from the CLI on their machine; afterwards use Retry reading."
              : "This browser couldn't read the current environment. Try reading it again.",
          );
          setLoadPhase("failed");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [session, available, loadAttempt]);
  const previousActorRef = useRef<EditorActor | null>(null);
  const reconciliationNoticeRef = useRef(false);
  useEffect(() => {
    const previous = previousActorRef.current;
    previousActorRef.current = { role, actorUserId };
    if (!previous) return;
    if (previous.role === role && previous.actorUserId === actorUserId) return;
    const reconciled = reconcileDraftWithPermissions(
      variables,
      remoteVariables,
      { role, actorUserId },
    );
    if (reconciled.droppedVariableNames.length === 0) {
      if (reconciliationNoticeRef.current) setPublishMessage(null);
      reconciliationNoticeRef.current = false;
      return;
    }
    const keptIds = new Set(
      reconciled.variables.map((variable) => variable.id),
    );
    const remoteById = new Map(
      remoteVariables.map((variable) => [variable.id, variable]),
    );
    const publishableIds = new Set(
      reconciled.variables
        .filter((variable) =>
          canActorPublishVariable(
            { role, actorUserId },
            variable,
            remoteById.get(variable.id),
          ),
        )
        .map((variable) => variable.id),
    );
    setVariables([...reconciled.variables]);
    setDeletedVariableSnapshots(
      (snapshots) => new Map([...snapshots].filter(([id]) => keptIds.has(id))),
    );
    setRollbackLanes(
      (current) => new Set([...current].filter((id) => publishableIds.has(id))),
    );
    setAddOpen(false);
    setReviewOpen(false);
    const names = reconciled.droppedVariableNames.join(" and ");
    const cause =
      previous.role !== role
        ? `Your team role changed to ${roleLabel(role)}.`
        : "This environment is now signed in as a different user.";
    setPublishMessage(
      `${cause} We removed ${names} from your draft because your current permissions no longer cover it. Other changes are kept.`,
    );
    reconciliationNoticeRef.current = true;
  }, [role, actorUserId, variables, remoteVariables]);
  const retryRead = () => {
    if (loadPhase !== "failed") return;
    setPublishMessage(null);
    setLoadPhase("loading");
    setLoadAttempt((attempt) => attempt + 1);
  };
  const currentScopeKeyRef = useRef(environmentContextKey(contextIdentity));
  useEffect(() => {
    currentScopeKeyRef.current = environmentContextKey(contextIdentity);
  }, [contextIdentity]);
  const inFlightOperationRef = useRef<Readonly<{
    readonly transport: ProtocolTransport;
    readonly operationId: string;
    readonly deviceId: string;
  }> | null>(null);
  const operationFinalizedRef = useRef(false);
  useEffect(
    () => () => {
      const inFlight = inFlightOperationRef.current;
      if (inFlight && !operationFinalizedRef.current)
        void inFlight.transport
          .cancel({
            operationId: inFlight.operationId,
            deviceId: inFlight.deviceId,
          })
          .catch(() => undefined);
    },
    [],
  );
  const [rollbackHistoricalValues, setRollbackHistoricalValues] = useState<
    ReadonlyMap<string, string | null>
  >(() => new Map());
  const [rollbackHistoryLoading, setRollbackHistoryLoading] = useState(false);
  const [rollbackHistoryError, setRollbackHistoryError] = useState<
    string | null
  >(null);
  const [rollbackUnresolvedVariableIds, setRollbackUnresolvedVariableIds] =
    useState<ReadonlySet<string>>(() => new Set());
  const rollbackLoadSequenceRef = useRef(0);
  const [rollbackValuesRevealed, setRollbackValuesRevealed] = useState(false);
  const resetRollbackState = useCallback(() => {
    rollbackLoadSequenceRef.current += 1;
    setRollbackTarget(null);
    setRollbackLanes(new Set());
    setRollbackHistoricalValues(new Map());
    setRollbackUnresolvedVariableIds(new Set());
    setRollbackHistoryError(null);
    setRollbackHistoryLoading(false);
    setRollbackValuesRevealed(false);
  }, []);
  useEffect(() => {
    if (active !== false) return;
    setAddOpen(false);
    setReviewOpen(false);
    setReviewValuesRevealed(false);
    resetRollbackState();
    setConflictValuesRevealed(false);
  }, [active, resetRollbackState]);
  const [deletedVariableSnapshots, setDeletedVariableSnapshots] = useState<
    ReadonlyMap<string, EnvironmentVariable>
  >(() => new Map());
  const [reviewValuesRevealed, setReviewValuesRevealed] = useState(false);
  const baselineFor = (id: string): EnvironmentVariable | undefined =>
    remoteVariables.find((variable) => variable.id === id);
  const withDraftFlag = (
    variable: EnvironmentVariable,
  ): EnvironmentVariable => ({
    ...variable,
    hasDraftChange: variableHasDraftChange(variable, baselineFor(variable.id)),
  });
  const changedCount = changedLaneCount(variables);
  const reportDraftDirtyRef = useRef(onDraftDirtyChange);
  reportDraftDirtyRef.current = onDraftDirtyChange;
  const hasDirtyDraft = changedCount > 0;
  const changedVariableNames = useMemo(
    () =>
      variables
        .filter((variable) => variable.hasDraftChange)
        .map((variable) => variable.name),
    [variables],
  );
  useEffect(() => {
    reportDraftDirtyRef.current?.(hasDirtyDraft, changedVariableNames);
  }, [hasDirtyDraft, changedVariableNames]);
  const pendingDiffs = draftValueDiffs(variables, remoteVariables);
  const pendingRollbackDiffs = rollbackValueDiffs(
    variables,
    rollbackHistoricalValues,
  );
  const unresolvedRollbackNames = [...rollbackUnresolvedVariableIds]
    .map((id) => variables.find((variable) => variable.id === id)?.name)
    .filter((name): name is string => name !== undefined);
  const disallowedDraftCount = variables.filter(
    (variable) =>
      variable.hasDraftChange &&
      !canActorPublishVariable(actor, variable, baselineFor(variable.id)),
  ).length;
  const canPublish =
    changedCount > 0 &&
    disallowedDraftCount === 0 &&
    staleHeadRevision === null &&
    loadPhase === "ready" &&
    !publishing;
  const allConflictsResolved =
    conflictLaneIds.size > 0 &&
    [...conflictLaneIds].every((id) => conflictChoices.has(id));
  const retryReady = staleHeadRevision !== null && allConflictsResolved;
  const historyRows: readonly VerifiedRevision[] = session
    ? verifiedHistory
    : [headRevision, "rev_0183", "rev_0182"].map((id) =>
        bareVerifiedRevision(id),
      );
  const rollbackTargetEntry = rollbackTarget
    ? (historyRows.find((entry) => entry.id === rollbackTarget) ?? null)
    : null;
  const historicalValues = new Map<string, string | null>([
    ["00000000-0000-4000-8000-000000000001", "https://api.acme.example"],
    ["00000000-0000-4000-8000-000000000002", ""],
    ["00000000-0000-4000-8000-000000000003", null],
  ]);

  const updateValue = (id: string, value: string) => {
    setPublishMessage(null);
    setVariables((current) =>
      current.map((variable) =>
        variable.id === id
          ? withDraftFlag(updateVariableValue(variable, value))
          : variable,
      ),
    );
  };

  const deleteVariable = (id: string) => {
    setPublishMessage(null);
    const variable = variables.find((candidate) => candidate.id === id);
    if (variable && !variable.tombstone)
      setDeletedVariableSnapshots((snapshots) => {
        const next = new Map(snapshots);
        next.set(id, variable);
        return next;
      });
    setVariables((current) =>
      current.map((candidate) =>
        candidate.id === id ? deleteEnvironmentVariable(candidate) : candidate,
      ),
    );
    setRevealed((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const undoDelete = (id: string) => {
    const snapshot = deletedVariableSnapshots.get(id);
    if (!snapshot) return;
    setVariables((current) =>
      current.map((variable) =>
        variable.id === id
          ? withDraftFlag({ ...snapshot, tombstone: false })
          : variable,
      ),
    );
    setDeletedVariableSnapshots((snapshots) => {
      const next = new Map(snapshots);
      next.delete(id);
      return next;
    });
  };

  const toggleReveal = (id: string) => {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createVariable = () => {
    if (loadPhase !== "ready") return;
    const error = validateVariableDraft(addDraft, variables);
    if (error) {
      setAddError(error);
      return;
    }
    const variable = createEnvironmentVariable(addDraft, nextVariableId(), {
      actorUserId,
    });
    setVariables((current) => [...current, variable]);
    setAddDraft(emptyVariableDraft);
    setAddError(null);
    setAddOpen(false);
  };

  const loadHistoricalValues = async (
    revision: string,
    variableIds: readonly string[],
  ): Promise<RollbackHistoryResolution> => {
    const rollbackSession = session;
    if (!rollbackSession?.resolveRollbackValues)
      return { values: historicalValues, unresolvedVariableIds: [] };
    return loadRollbackHistory(rollbackSession.resolveRollbackValues, {
      targetRevision: revision,
      variableIds,
    });
  };

  const canRollbackVariable = (variable: EnvironmentVariable): boolean =>
    !variable.tombstone &&
    canActorPublishVariable(actor, variable, baselineFor(variable.id));
  const canStageAnyRollback = variables.some((variable) =>
    canRollbackVariable(variable),
  );
  const openRollback = async (revision: string) => {
    const requestedVariableIds = variables.map((variable) => variable.id);
    resetRollbackState();
    const loadSequence = ++rollbackLoadSequenceRef.current;
    setRollbackTarget(revision);
    setRollbackHistoryLoading(true);
    const history = await loadHistoricalValues(revision, requestedVariableIds);
    if (rollbackLoadSequenceRef.current !== loadSequence) return;
    setRollbackHistoryLoading(false);
    if (
      requestedVariableIds.length > 0 &&
      history.values.size === 0 &&
      history.unresolvedVariableIds.length === requestedVariableIds.length
    ) {
      setRollbackHistoryError(
        "This device couldn't read this revision's values, so the comparison isn't possible. Nothing was staged.",
      );
      return;
    }
    const diffs = rollbackValueDiffs(variables, history.values);
    const selectableIds = new Set(
      variables
        .filter((variable) => canRollbackVariable(variable))
        .map((variable) => variable.id),
    );
    setRollbackHistoricalValues(history.values);
    setRollbackUnresolvedVariableIds(new Set(history.unresolvedVariableIds));
    setRollbackLanes(
      new Set(
        diffs.map((diff) => diff.id).filter((id) => selectableIds.has(id)),
      ),
    );
  };

  const clearConflictState = () => {
    setConflictLaneIds(new Set());
    setConflictChoices(new Map());
    setConflictValuesRevealed(false);
    setStaleHeadRevision(null);
  };

  const runPublish = async (
    publishVariables: readonly EnvironmentVariable[],
  ) => {
    if (changedLaneCount(publishVariables) === 0) return;
    const publishSession = session;
    const scopeAtStart = currentScopeKeyRef.current;
    const scopeLost = () => currentScopeKeyRef.current !== scopeAtStart;
    setPublishing(true);
    try {
      if (publishSession) {
        const context = publishSession.context;
        const expectedHeadId = protocolHead?.id ?? context.expectedHeadId;
        const expectedHeadHash = protocolHead?.hash ?? context.expectedHeadHash;
        const mutation = publicationMutationForHead({
          expectedHeadId,
          rollbackTargetId: rollbackMutationTarget,
        });
        const artifacts = await createPublicationArtifacts(publishVariables, {
          ...context,
          expectedHeadId,
          expectedHeadHash,
          mutation,
          ...(rollbackMutationTarget
            ? {
                rollbackTargetId: rollbackMutationTarget,
                rollbackSelectedVariableIds: [...rollbackLanes],
              }
            : {}),
        });
        if (scopeLost()) return;
        const operationId = globalThis.crypto.randomUUID();
        operationFinalizedRef.current = false;
        inFlightOperationRef.current = {
          transport: publishSession.transport,
          operationId,
          deviceId: context.actorDeviceId,
        };
        await publishSession.transport.begin({
          operationId,
          deviceId: context.actorDeviceId,
          kind: mutation === "ROLLBACK" ? "ROLLBACK" : "REVISION_PUBLICATION",
          commandBytes: artifacts.commandBytes,
          commandDigest: await sha384(artifacts.commandBytes),
        });
        if (scopeLost()) {
          inFlightOperationRef.current = null;
          await publishSession.transport
            .cancel({
              operationId,
              deviceId: context.actorDeviceId,
            })
            .catch(() => undefined);
          return;
        }
        try {
          for (const staged of artifacts.stagedObjects)
            await publishSession.transport.stage({
              operationId,
              deviceId: context.actorDeviceId,
              objectId: staged.objectId,
              bytes: staged.bytes,
            });
          await publishSession.transport.finalize({
            operationId,
            deviceId: context.actorDeviceId,
            request: artifacts.request,
          });
        } catch (error) {
          await publishSession.transport
            .cancel({
              operationId,
              deviceId: context.actorDeviceId,
            })
            .catch(() => undefined);
          throw error;
        }
        inFlightOperationRef.current = null;
        operationFinalizedRef.current = true;
        if (scopeLost()) return;
        const revisionObject = artifacts.stagedObjects.find(
          (staged) =>
            staged.objectId === artifacts.request.revision.protocolObjectId,
        );
        if (revisionObject) {
          const nextHeadHash = await sha384(revisionObject.bytes);
          setProtocolHead({
            id: artifacts.request.revision.id,
            hash: nextHeadHash,
          });
          setHeadRevision(artifacts.request.revision.id);
          setVerifiedHistory((current) =>
            mergeVerifiedHistory(current, [
              locallyPublishedRevision({
                id: artifacts.request.revision.id,
                parentId: expectedHeadId ?? context.environmentId,
                mutation,
                projectEpoch: context.projectEpoch,
                authoredAtMs: artifacts.request.revision.authoredAtMs,
                rollbackTargetId:
                  artifacts.request.revision.rollbackTargetId ?? null,
                authorUserId: context.actorUserId,
              }),
            ]),
          );
        }
        setVariables((current) =>
          settlePublishedDraft(current, publishVariables),
        );
        setDeletedVariableSnapshots(new Map());
        setRemoteVariables(publishedBaseline(publishVariables));
        setRollbackMutationTarget(null);
        clearConflictState();
        setReviewOpen(false);
        setPublishMessage(`Published as ${artifacts.request.revision.id}.`);
        return;
      }
      await prepareEncryptedPublication(publishVariables);
      const nextRevision = revisionNumber(headRevision) + 1;
      setHeadRevision(`rev_${String(nextRevision).padStart(4, "0")}`);
      setVariables((current) =>
        settlePublishedDraft(current, publishVariables),
      );
      setDeletedVariableSnapshots(new Map());
      setRemoteVariables(publishedBaseline(publishVariables));
      clearConflictState();
      setReviewOpen(false);
      setPublishMessage(
        `Local preview saved as rev_${String(nextRevision).padStart(4, "0")}.`,
      );
    } catch (error) {
      if (
        publishSession &&
        error instanceof ProtocolTransportError &&
        error.problem.code === "stale_head"
      ) {
        if (scopeLost()) {
          setPublishMessage("Publish was rejected. Refresh and try again.");
          return;
        }
        try {
          const context = publishSession.context;
          const page = await publishSession.transport.syncAll({
            environmentId: context.environmentId,
            deviceId: context.actorDeviceId,
            request: {
              trustedRevisionId:
                protocolHead?.id ??
                context.expectedHeadId ??
                context.trustedRevisionId ??
                context.environmentId,
              trustedRevisionHash:
                protocolHead?.hash ??
                context.expectedHeadHash ??
                context.trustedRevisionHash ??
                new Uint8Array(48),
              pagination: {},
            },
          });
          await verifySyncPage(page, sessionSigningTrust(publishSession), {
            actorUserId: context.actorUserId,
          });
          setVerifiedHistory((current) =>
            mergeVerifiedHistory(current, verifiedRevisionsFromPage(page)),
          );
          const remoteChangedVariableIds = changedVariableIdsFromSyncPage(page);
          const decodedVariables = publishSession.decodeVariables
            ? await publishSession.decodeVariables(page, remoteVariables)
            : undefined;
          if (decodedVariables) setRemoteVariables(decodedVariables);
          if (!page.currentHeadId || !page.currentHeadHash)
            throw new Error(
              "the stale response did not provide a verified head",
            );
          const localChangedVariableIds = publishVariables
            .filter((variable) => variable.hasDraftChange)
            .map((variable) => variable.id);
          const conflictingVariableIds =
            page.nextCursor !== null
              ? localChangedVariableIds
              : localChangedVariableIds.filter((id) =>
                  remoteChangedVariableIds.has(id),
                );
          setProtocolHead({
            id: page.currentHeadId,
            hash: page.currentHeadHash,
          });
          setHeadRevision(page.currentHeadId);
          setConflictLaneIds(new Set(conflictingVariableIds));
          setConflictChoices(new Map());
          setConflictValuesRevealed(false);
          setStaleHeadRevision(
            conflictingVariableIds.length > 0 ? page.currentHeadId : null,
          );
          setReviewOpen(false);
          setPublishMessage(
            conflictingVariableIds.length > 0
              ? "Publish did not go through because someone else changed the same variables. Compare both versions, pick what to keep, then retry."
              : "Someone else published changes to other variables. Your draft is still ready to publish.",
          );
        } catch {
          setPublishMessage(
            "Publish stopped because someone else updated this environment first. Refresh and try again.",
          );
        }
        return;
      }
      setPublishMessage("Publish was rejected. Refresh and try again.");
    } finally {
      setPublishing(false);
    }
  };

  const publish = () => {
    void runPublish(variables);
  };

  const materializeConflicts = (): EnvironmentVariable[] =>
    variables.map((variable) => {
      const choice = conflictChoices.get(variable.id);
      if (!choice) return variable;
      const remote =
        remoteVariables.find((candidate) => candidate.id === variable.id) ??
        null;
      const resolved = applyConflictResolution(variable, remote, choice);
      return {
        ...resolved,
        hasDraftChange: variableHasDraftChange(resolved, remote ?? undefined),
      };
    });

  const chooseConflict = (id: string, choice: ConflictResolution) => {
    setConflictChoices((current) => {
      const next = new Map(current);
      next.set(id, choice);
      return next;
    });
  };

  const revisitConflict = (id: string) => {
    setConflictChoices((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  };

  const retryAgainstVerifiedHead = () => {
    if (!staleHeadRevision || publishing) return;
    const materialized = materializeConflicts();
    if (changedLaneCount(materialized) === 0) {
      clearConflictState();
      setHeadRevision(staleHeadRevision);
      setPublishMessage(
        "Nothing to publish: every conflict already matched the latest revision.",
      );
      return;
    }
    const reconciled = reconcileDraftWithPermissions(
      materialized,
      remoteVariables,
      actor,
    ).variables;
    if (changedLaneCount(reconciled) === 0) {
      clearConflictState();
      setHeadRevision(staleHeadRevision);
      setPublishMessage(
        "Nothing to publish: your current permissions no longer cover the kept changes.",
      );
      return;
    }
    setVariables([...reconciled]);
    setHeadRevision(staleHeadRevision);
    setPublishMessage(null);
    void runPublish(reconciled);
  };

  const applyRollback = async () => {
    if (!rollbackTarget || rollbackLanes.size === 0) return;
    try {
      createRollbackPlan(rollbackTarget, [...rollbackLanes]);
      const nextVariables = applyRollbackToVariables(
        variables,
        rollbackHistoricalValues,
        [...rollbackLanes],
      );
      setVariables(nextVariables.map(withDraftFlag));
    } catch {
      setPublishMessage(
        "Rollback stopped because this revision's values couldn't be read.",
      );
      return;
    }
    setRollbackTarget(null);
    setRollbackMutationTarget(rollbackTarget);
    setPublishMessage(
      `Values from ${rollbackTarget} are in your draft. Review and publish to save the rollback as a new revision.`,
    );
  };

  if (!available) {
    const action = setupAction;
    return (
      <section className="scroll-mt-24" id="environment">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LockKeyhole className="size-5 text-amber-300" />
              <h2>
                {loading
                  ? "Loading environment…"
                  : (action?.title ?? "Variables are hidden")}
              </h2>
            </CardTitle>
            <CardDescription>
              {loading ? (
                "Fetching the latest verified state for this environment."
              ) : (
                <CommandText
                  text={
                    action?.body ??
                    "Set up this browser to view and edit its variables."
                  }
                />
              )}
            </CardDescription>
          </CardHeader>
          {setupCommand || setupMessage ? (
            <CardContent className="space-y-3">
              {setupCommand ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Prefer the CLI? It sets up the CLI on this machine, not this
                    browser.
                  </p>
                  <CopyableCommand
                    className="mt-2"
                    data-testid="cli-setup-command"
                    value={setupCommand}
                  />
                </>
              ) : null}
              {setupMessage ? (
                <p className="text-sm text-muted-foreground" role="status">
                  <CommandText text={setupMessage} />
                </p>
              ) : null}
            </CardContent>
          ) : null}
          {action && (onSetupAction || action.id === "sign-in") ? (
            <CardFooter>
              {action.id === "sign-in" ? (
                <a
                  className="inline-flex h-8 items-center rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground"
                  href="/sign-in"
                >
                  {action.actionLabel}
                </a>
              ) : (
                <Button
                  disabled={setupBusy}
                  onClick={onSetupAction}
                  type="button"
                >
                  {action.actionLabel}
                </Button>
              )}
            </CardFooter>
          ) : null}
        </Card>
      </section>
    );
  }

  return (
    <section className="scroll-mt-24" id="environment">
      {publishMessage ? (
        <Alert className="mb-4 bg-card/60">
          <Check className="text-primary" />
          <AlertTitle>Status</AlertTitle>
          <AlertDescription>{publishMessage}</AlertDescription>
        </Alert>
      ) : null}

      {conflictLaneIds.size > 0 ? (
        <Card className="mb-4 border-amber-300/30">
          <CardHeader>
            <CardTitle>Someone else published these</CardTitle>
            <CardDescription>
              Compare your draft with the verified changes from the server.
              Choose what to keep for each variable, then retry publishing.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex justify-end">
              <Button
                aria-pressed={conflictValuesRevealed}
                onClick={() => setConflictValuesRevealed((current) => !current)}
                size="xs"
                variant="ghost"
              >
                {conflictValuesRevealed ? (
                  <EyeOff aria-hidden="true" />
                ) : (
                  <Eye aria-hidden="true" />
                )}
                {conflictValuesRevealed ? "Hide values" : "Show values"}
              </Button>
            </div>
            {[...conflictLaneIds].map((id) => {
              const local = variables.find((variable) => variable.id === id);
              if (!local) return null;
              const remote =
                remoteVariables.find((candidate) => candidate.id === id) ??
                null;
              return (
                <ConflictLane
                  choice={conflictChoices.get(id) ?? null}
                  key={id}
                  onChoose={(choice) => chooseConflict(id, choice)}
                  onRevisit={() => revisitConflict(id)}
                  revealed={conflictValuesRevealed}
                  summary={summarizeConflict(local, remote)}
                />
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {retryReady && staleHeadRevision ? (
        <Alert className="mb-4 border-primary/25 bg-primary/5">
          <Check className="text-primary" />
          <AlertTitle>
            {publishing ? "Retrying publish" : "Ready to retry"}
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {publishing
                ? "Publishing your choices on top of the latest revision…"
                : "Every conflict is resolved. Retrying publishes your choices on top of the latest revision."}
            </span>
            <Button
              disabled={publishing}
              onClick={retryAgainstVerifiedHead}
              size="sm"
            >
              {publishing ? "Publishing…" : "Retry publish"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <List aria-hidden="true" className="size-4" />
            <h2>Variables</h2>
          </CardTitle>
          <CardAction className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={loadPhase !== "ready" || !canChangeDefinitions}
              onClick={() => {
                setAddError(null);
                setAddOpen(true);
              }}
              size="sm"
              variant="outline"
            >
              <Plus aria-hidden="true" /> Add variable
            </Button>
            <Button
              disabled={!canPublish}
              onClick={() => {
                setReviewValuesRevealed(false);
                setReviewOpen(true);
              }}
              size="sm"
            >
              <Save aria-hidden="true" /> Save changes
            </Button>
            {loadPhase === "failed" ? (
              <Button
                data-testid="environment-retry-read"
                onClick={retryRead}
                size="sm"
                variant="outline"
              >
                <RotateCcw aria-hidden="true" /> Retry reading
              </Button>
            ) : null}
          </CardAction>
          {!canChangeDefinitions ? (
            <CardDescription data-testid="member-permissions-note">
              As a {roleLabel(role).toLowerCase()}, you can read every variable.
              You can edit the user-defined values you own and the shared values
              you originally provided. Owners and admins can edit other values,
              and add or delete variables.
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="px-0">
          {variables.length === 0 ? (
            loadPhase === "loading" ? (
              <p
                className="px-4 py-6 text-sm text-muted-foreground"
                role="status"
              >
                Loading environment…
              </p>
            ) : loadPhase === "failed" ? (
              <p
                className="px-4 py-6 text-sm text-muted-foreground"
                data-testid="environment-read-failed"
                role="status"
              >
                This environment couldn't be read, so its variables are hidden.
                Use Retry reading to try again.
              </p>
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                Add a variable to save your first secrets here.
              </p>
            )
          ) : (
            <ul className="divide-y divide-border">
              {variables.map((variable) => (
                <VariableRow
                  canDelete={canChangeDefinitions}
                  canEdit={canActorChangeVariableValue(actor, variable)}
                  canUndoDelete={deletedVariableSnapshots.has(variable.id)}
                  editingDisabled={loadPhase !== "ready"}
                  key={variable.id}
                  onDelete={() => deleteVariable(variable.id)}
                  onSetAbsent={() =>
                    setVariables((current) =>
                      current.map((candidate) =>
                        candidate.id === variable.id
                          ? withDraftFlag(updateVariableValue(candidate, null))
                          : candidate,
                      ),
                    )
                  }
                  onToggleReveal={() => toggleReveal(variable.id)}
                  onUndoDelete={() => undoDelete(variable.id)}
                  onValueChange={(value) => updateValue(variable.id, value)}
                  readOnlyDisclosure={readOnlyReason(actor, variable)}
                  revealed={revealed.has(variable.id)}
                  variable={variable}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <GitBranch className="size-4" /> History
          </CardTitle>
          <CardDescription>
            Verified revisions of this environment. Choose an earlier revision
            to restore selected values. Publishing a rollback creates a new
            revision and keeps the existing history.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {historyRows.map((revision) => {
            const isCurrent = revision.id === headRevision;
            const rollbackTargetId = revision.rollbackTargetId;
            const rollbackTargetKnown =
              rollbackTargetId !== null &&
              historyRows.some((entry) => entry.id === rollbackTargetId);
            return (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                data-testid={`history-revision-${revision.id}`}
                key={revision.id}
              >
                <div className="min-w-0">
                  <RevisionIdentity
                    actorUserId={session?.context.actorUserId}
                    lineSuffix={
                      <>
                        {rollbackTargetId !== null
                          ? ` · Rollback of ${rollbackTargetKnown ? displayRevisionId(rollbackTargetId) : "an earlier revision"}`
                          : null}
                        {!isCurrent ? " · Earlier revision" : null}
                      </>
                    }
                    revision={revision}
                  />
                </div>
                {isCurrent ? (
                  <Badge>Current</Badge>
                ) : (
                  <Button
                    disabled={loadPhase !== "ready" || !canStageAnyRollback}
                    onClick={() => {
                      void openRollback(revision.id);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <RotateCcw aria-hidden="true" /> Rollback
                  </Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <AddVariableDialog
        draft={addDraft}
        error={addError}
        onCreate={createVariable}
        onDraftChange={setAddDraft}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setAddDraft(emptyVariableDraft);
        }}
        open={addOpen}
      />

      <Dialog
        onOpenChange={(open) => {
          setReviewOpen(open);
          if (!open) setReviewValuesRevealed(false);
        }}
        open={reviewOpen}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Save changes</DialogTitle>
            <DialogDescription>
              Publish to save these changes as a new revision. Shared values are
              available to your team. User-defined values remain private to
              their owner.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button
              aria-pressed={reviewValuesRevealed}
              onClick={() => setReviewValuesRevealed((current) => !current)}
              size="xs"
              variant="ghost"
            >
              {reviewValuesRevealed ? (
                <EyeOff aria-hidden="true" />
              ) : (
                <Eye aria-hidden="true" />
              )}
              {reviewValuesRevealed ? "Hide values" : "Show values"}
            </Button>
          </div>
          <div className="grid max-h-[min(50vh,28rem)] gap-2 overflow-y-auto">
            {pendingDiffs.map((diff) => (
              <div className="rounded-lg border p-3" key={diff.id}>
                <ValueDiffLines diff={diff} revealed={reviewValuesRevealed} />
              </div>
            ))}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={!canPublish} onClick={publish}>
              {publishing ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) resetRollbackState();
        }}
        open={rollbackTarget !== null}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Rollback</DialogTitle>
            <DialogDescription>
              Choose which values to restore from this revision. Nothing is
              saved until you publish the draft. Publishing creates a new
              revision without deleting the current one.
            </DialogDescription>
          </DialogHeader>
          {rollbackTargetEntry ? (
            <div className="grid gap-1 rounded-lg border bg-muted/20 p-3">
              <RevisionIdentity
                actorUserId={session?.context.actorUserId}
                idClassName="font-mono text-sm font-medium"
                revision={rollbackTargetEntry}
              />
              <p className="text-xs text-muted-foreground">
                Staging puts the selected values in your draft. Review and
                publish the draft to save a new revision. Earlier history and
                unselected variables stay unchanged.
              </p>
            </div>
          ) : null}
          {rollbackHistoryLoading ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="rollback-history-loading"
              role="status"
            >
              Reading this revision's values…
            </p>
          ) : rollbackHistoryError !== null ? (
            <Alert
              className="mt-2 border-destructive/30"
              data-testid="rollback-history-error"
            >
              <AlertTitle>Rollback history unavailable</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                <span>{rollbackHistoryError}</span>
                <div>
                  <Button
                    disabled={rollbackTarget === null}
                    onClick={() => {
                      if (rollbackTarget !== null)
                        void openRollback(rollbackTarget);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <RotateCcw aria-hidden="true" /> Retry reading
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : pendingRollbackDiffs.length === 0 &&
            rollbackUnresolvedVariableIds.size === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is different from this revision.
            </p>
          ) : (
            <>
              {rollbackUnresolvedVariableIds.size > 0 ? (
                <Alert
                  className="mt-2 border-amber-300/30"
                  data-testid="rollback-history-partial"
                >
                  <AlertTitle>Partial comparison</AlertTitle>
                  <AlertDescription>
                    {`The values for ${unresolvedRollbackNames.join(", ")} couldn't be read from this revision, so the comparison is incomplete. Only values this browser could read and verify can go into the rollback draft.`}
                  </AlertDescription>
                </Alert>
              ) : null}
              {pendingRollbackDiffs.length > 0 ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {rollbackLanes.size} of {pendingRollbackDiffs.length}{" "}
                      variables selected
                    </p>
                    <Button
                      aria-pressed={rollbackValuesRevealed}
                      onClick={() =>
                        setRollbackValuesRevealed((current) => !current)
                      }
                      size="xs"
                      variant="ghost"
                    >
                      {rollbackValuesRevealed ? (
                        <EyeOff aria-hidden="true" />
                      ) : (
                        <Eye aria-hidden="true" />
                      )}
                      {rollbackValuesRevealed ? "Hide values" : "Show values"}
                    </Button>
                  </div>
                  <div className="grid max-h-[min(50vh,28rem)] gap-2 overflow-y-auto">
                    {pendingRollbackDiffs.map((diff) => {
                      const rollbackVariable = variables.find(
                        (candidate) => candidate.id === diff.id,
                      );
                      const selectable =
                        rollbackVariable !== undefined &&
                        canRollbackVariable(rollbackVariable);
                      return (
                        <label
                          className="flex items-start gap-3 rounded-lg border p-3"
                          key={diff.id}
                        >
                          <input
                            checked={rollbackLanes.has(diff.id)}
                            className="mt-1"
                            disabled={!selectable}
                            onChange={(event) =>
                              setRollbackLanes((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(diff.id);
                                else next.delete(diff.id);
                                return next;
                              })
                            }
                            type="checkbox"
                          />
                          <span className="grid min-w-0 flex-1 gap-1">
                            <ValueDiffLines
                              diff={diff}
                              revealed={rollbackValuesRevealed}
                            />
                            {!selectable ? (
                              <span className="text-[11px] text-muted-foreground">
                                {rollbackVariable
                                  ? (readOnlyReason(actor, rollbackVariable) ??
                                    (rollbackVariable.tombstone
                                      ? "This variable is marked for deletion in your draft."
                                      : null))
                                  : null}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={
                rollbackLanes.size === 0 ||
                rollbackHistoryLoading ||
                rollbackHistoryError !== null
              }
              onClick={applyRollback}
            >
              Stage rollback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
