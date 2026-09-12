"use client";

import {
  changedVariableIdsFromSyncPage,
  createPublicationArtifacts,
  type ProtocolTransport,
  ProtocolTransportError,
  type PublicationContext,
  type SyncPageWire,
  sha384,
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
import { useEffect, useRef, useState } from "react";
import { CopyableCommand } from "@/components/copyable-command";
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
  applyRollbackToVariables,
  changedLaneCount,
  createEnvironmentVariable,
  createRollbackPlan,
  deleteEnvironmentVariable,
  draftValueDiffs,
  type EnvironmentVariable,
  mergeVerifiedHistory,
  prepareEncryptedPublication,
  publicationMutationForHead,
  rollbackValueDiffs,
  type SetupAction,
  splitInlineValueDiff,
  updateVariableValue,
  type VariableDraft,
  type VariableValueDiff,
  validateVariableDraft,
  variableHasDraftChange,
} from "@/lib/environment-workflow";

type EnvironmentEditorProps = Readonly<{
  readonly available: boolean;
  readonly active?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly contextIdentity: EnvironmentContextIdentity;
  readonly onDraftDirtyChange?: (dirty: boolean) => void;
  readonly setupAction?: SetupAction | null | undefined;
  readonly setupCommand?: string | undefined;
  readonly setupMessage?: string | null | undefined;
  readonly setupBusy?: boolean | undefined;
  readonly onSetupAction?: (() => void) | undefined;
  readonly protocolSession?:
    | Readonly<{
        readonly context: PublicationContext;
        readonly transport: ProtocolTransport;
        readonly signingTrustKeys?: readonly Uint8Array[];
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
    description: "Shared service origin used by the Team.",
    ownership: "SHARED_VALUE",
    value: "",
    required: true,
    hasDraftChange: false,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "SIGNING_KEY",
    description: "User-defined signing material for this Device.",
    ownership: "USER_DEFINED_VALUE",
    value: "",
    required: true,
    hasDraftChange: false,
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    name: "FEATURE_GATE",
    description: "Optional Team feature flag.",
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
  ownership === "SHARED_VALUE" ? "Shared Value" : "User-defined Value";

const sessionTrustKeys = (
  session: NonNullable<EnvironmentEditorProps["protocolSession"]>,
): Uint8Array | readonly Uint8Array[] => {
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
      <div className="min-w-0 font-mono text-[13px] leading-5">
        <p className="truncate font-medium text-foreground" title={diff.name}>
          {diff.name}
        </p>
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
    <div className="min-w-0 font-mono text-[13px] leading-5">
      <p className="truncate font-medium text-foreground" title={diff.name}>
        {diff.name}
      </p>
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

const VariableRow = ({
  variable,
  revealed,
  canUndoDelete,
  onDelete,
  onSetAbsent,
  onToggleReveal,
  onUndoDelete,
  onValueChange,
}: {
  readonly variable: EnvironmentVariable;
  readonly revealed: boolean;
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
          <div className="flex min-w-0 items-baseline gap-x-2">
            <span
              className="truncate font-mono text-[13px] font-medium tracking-tight"
              title={variable.name}
            >
              {variable.name}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {ownershipLabel(variable.ownership)}
            </span>
            {variable.hasDraftChange ? (
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-amber-200">
                Draft change
              </span>
            ) : null}
          </div>
          {variable.description ? (
            <p
              className="truncate text-[11px] leading-4 text-muted-foreground/80"
              title={variable.description}
            >
              {variable.description}
            </p>
          ) : null}
        </div>

        {variable.tombstone ? (
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              This Variable is marked for deletion.
            </span>
            {variable.hasDraftChange && canUndoDelete ? (
              <Button onClick={onUndoDelete} size="xs" variant="outline">
                Undo delete
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Label className="sr-only" htmlFor={`value-${variable.id}`}>
              {variable.name} Value
            </Label>
            <Input
              autoComplete="off"
              className="h-7 font-mono text-[13px]"
              id={`value-${variable.id}`}
              onChange={(event) => onValueChange(event.target.value)}
              placeholder={variable.value === null ? "Absent" : "Empty Value"}
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
              <Button onClick={onSetAbsent} size="xs" variant="ghost">
                Set absent
              </Button>
            ) : null}
            <Button
              aria-label={`Delete ${variable.name}`}
              className="text-muted-foreground hover:text-destructive"
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
}) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add Variable</DialogTitle>
        <DialogDescription>
          Name it, choose who can read it, and set the first value.
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
            placeholder="What this Variable is used for"
            value={draft.description}
          />
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Value ownership</legend>
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
              <span className="block text-sm font-medium">Shared Value</span>
              <span className="block text-xs text-muted-foreground">
                Everyone in the Team can read this. Admins can change it.
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
                User-defined Value
              </span>
              <span className="block text-xs text-muted-foreground">
                Only this User&apos;s Devices can read it.
              </span>
            </span>
          </label>
        </fieldset>
        <div className="grid gap-2">
          <Label htmlFor="new-variable-value">Initial Value</Label>
          <Input
            autoComplete="off"
            id="new-variable-value"
            onChange={(event) =>
              onDraftChange({ ...draft, value: event.target.value })
            }
            placeholder="Leave blank for an intentional empty Value"
            type="password"
            value={draft.value}
          />
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
            Create without a Value (absent, not an empty Value)
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
          This Variable requires a Value
        </label>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button onClick={onCreate}>
          <Plus aria-hidden="true" /> Add Variable
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const EnvironmentEditor = ({
  available,
  active,
  loading,
  contextIdentity,
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
  const [verifiedHistory, setVerifiedHistory] = useState<readonly string[]>([]);
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
  const [conflictingLaneIds, setConflictingLaneIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [staleHeadRevision, setStaleHeadRevision] = useState<string | null>(
    null,
  );
  const [retryReady, setRetryReady] = useState(false);
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
    setLoadPhase("loading");
  }, [session]);
  useEffect(() => {
    if (!session || !available) return;
    let cancelled = false;
    const load = async () => {
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
        await verifySyncPage(page, sessionTrustKeys(session), {
          actorUserId: context.actorUserId,
        });
        if (cancelled) return;
        const decoded = session.decodeVariables
          ? await session.decodeVariables(page, [])
          : undefined;
        if (cancelled || !decoded) return;
        setRemoteVariables(decoded);
        setVariables((current) =>
          current.some((variable) => variable.hasDraftChange)
            ? current
            : [...decoded],
        );
        setVerifiedHistory((current) =>
          mergeVerifiedHistory(
            current,
            page.revisions.map((revision) => revision.id),
          ),
        );
        if (page.currentHeadId && page.currentHeadHash) {
          setProtocolHead({
            id: page.currentHeadId,
            hash: page.currentHeadHash,
          });
          setHeadRevision(page.currentHeadId);
        }
        if (!cancelled) setLoadPhase("ready");
      } catch {
        if (!cancelled) {
          setPublishMessage(
            "This Device could not read the current Environment.",
          );
          setLoadPhase("failed");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [session, available]);
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
  useEffect(() => {
    if (active !== false) return;
    setAddOpen(false);
    setReviewOpen(false);
    setRollbackTarget(null);
    setRollbackLanes(new Set());
  }, [active]);
  const [deletedVariableSnapshots, setDeletedVariableSnapshots] = useState<
    ReadonlyMap<string, EnvironmentVariable>
  >(() => new Map());
  const [rollbackHistoricalValues, setRollbackHistoricalValues] = useState<
    ReadonlyMap<string, string | null>
  >(() => new Map());
  const [reviewValuesRevealed, setReviewValuesRevealed] = useState(true);
  const [rollbackValuesRevealed, setRollbackValuesRevealed] = useState(true);
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
  useEffect(() => {
    reportDraftDirtyRef.current?.(hasDirtyDraft);
  }, [hasDirtyDraft]);
  const pendingDiffs = draftValueDiffs(variables, remoteVariables);
  const pendingRollbackDiffs = rollbackValueDiffs(
    variables,
    rollbackHistoricalValues,
  );
  const canPublish =
    changedCount > 0 &&
    conflictingLaneIds.size === 0 &&
    staleHeadRevision === null &&
    loadPhase !== "loading" &&
    !publishing;
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
    const error = validateVariableDraft(addDraft, variables);
    if (error) {
      setAddError(error);
      return;
    }
    const variable = createEnvironmentVariable(addDraft, nextVariableId());
    setVariables((current) => [...current, variable]);
    setAddDraft(emptyVariableDraft);
    setAddError(null);
    setAddOpen(false);
  };

  const loadHistoricalValues = async (
    revision: string,
    variableIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>> => {
    const rollbackSession = session;
    if (!rollbackSession?.resolveRollbackValues) return historicalValues;
    try {
      return await rollbackSession.resolveRollbackValues({
        targetRevision: revision,
        selectedVariableIds: variableIds,
      });
    } catch {
      const values = new Map<string, string | null>();
      for (const variableId of variableIds) {
        try {
          const one = await rollbackSession.resolveRollbackValues({
            targetRevision: revision,
            selectedVariableIds: [variableId],
          });
          if (one.has(variableId))
            values.set(variableId, one.get(variableId) ?? null);
        } catch {
          // This Variable did not exist in that revision.
        }
      }
      return values;
    }
  };

  const openRollback = async (revision: string) => {
    const values = await loadHistoricalValues(
      revision,
      variables.map((variable) => variable.id),
    );
    const diffs = rollbackValueDiffs(variables, values);
    setRollbackHistoricalValues(values);
    setRollbackLanes(new Set(diffs.map((diff) => diff.id)));
    setRollbackValuesRevealed(true);
    setRollbackTarget(revision);
  };

  const publish = async () => {
    if (changedCount === 0) return;
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
        const artifacts = await createPublicationArtifacts(variables, {
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
            mergeVerifiedHistory(current, [artifacts.request.revision.id]),
          );
        }
        setVariables((current) =>
          current.map((variable) => ({ ...variable, hasDraftChange: false })),
        );
        setDeletedVariableSnapshots(new Map());
        setRemoteVariables(
          variables.map((variable) => ({
            ...variable,
            hasDraftChange: false,
          })),
        );
        setRollbackMutationTarget(null);
        setConflictingLaneIds(new Set());
        setStaleHeadRevision(null);
        setRetryReady(false);
        setReviewOpen(false);
        setPublishMessage(`Published as ${artifacts.request.revision.id}.`);
        return;
      }
      await prepareEncryptedPublication(variables);
      const nextRevision = revisionNumber(headRevision) + 1;
      setHeadRevision(`rev_${String(nextRevision).padStart(4, "0")}`);
      setVariables((current) =>
        current.map((variable) => ({ ...variable, hasDraftChange: false })),
      );
      setDeletedVariableSnapshots(new Map());
      setConflictingLaneIds(new Set());
      setStaleHeadRevision(null);
      setRetryReady(false);
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
          await verifySyncPage(page, sessionTrustKeys(publishSession), {
            actorUserId: context.actorUserId,
          });
          setVerifiedHistory((current) =>
            mergeVerifiedHistory(
              current,
              page.revisions.map((revision) => revision.id),
            ),
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
          const localChangedVariableIds = variables
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
          setConflictingLaneIds(new Set(conflictingVariableIds));
          setStaleHeadRevision(
            conflictingVariableIds.length > 0 ? page.currentHeadId : null,
          );
          setRetryReady(false);
          setReviewOpen(false);
          setPublishMessage(
            conflictingVariableIds.length > 0
              ? "Publish did not go through because someone else changed the same variables. Pick which value to keep, then retry."
              : "Someone else published other variables. Your draft is still ready to publish.",
          );
        } catch {
          setPublishMessage(
            "Publish stopped after someone else updated this Environment. Refresh and try again.",
          );
        }
        return;
      }
      setPublishMessage("Publish was rejected. Refresh and try again.");
    } finally {
      setPublishing(false);
    }
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
        "Rollback stopped because this revision's values could not be read.",
      );
      return;
    }
    setRollbackTarget(null);
    setRollbackMutationTarget(rollbackTarget);
    setPublishMessage(
      `Rollback from ${rollbackTarget} is staged as a new revision.`,
    );
  };

  const resolveConflict = (
    id: string,
    choice: "local" | "remote" | "merge",
  ) => {
    if (choice === "remote") {
      setVariables((current) =>
        current.map((variable) =>
          variable.id === id
            ? (() => {
                const remote = remoteVariables.find(
                  (candidate) => candidate.id === id,
                );
                return remote
                  ? { ...remote, id, hasDraftChange: false }
                  : {
                      ...variable,
                      value: null,
                      tombstone: true,
                      hasDraftChange: false,
                    };
              })()
            : variable,
        ),
      );
    }
    if (choice === "local") {
      setVariables((current) =>
        current.map((variable) =>
          variable.id === id ? { ...variable, hasDraftChange: true } : variable,
        ),
      );
    }
    if (choice === "merge") {
      setVariables((current) =>
        current.map((variable) => {
          if (variable.id !== id) return variable;
          const remote = remoteVariables.find(
            (candidate) => candidate.id === id,
          );
          return remote
            ? {
                ...remote,
                value: variable.value,
                hasDraftChange: true,
                ...(variable.tombstone === undefined
                  ? {}
                  : { tombstone: variable.tombstone }),
              }
            : { ...variable, hasDraftChange: true };
        }),
      );
    }
    setConflictingLaneIds((current) => {
      const next = new Set(current);
      next.delete(id);
      if (next.size === 0 && staleHeadRevision) setRetryReady(true);
      return next;
    });
  };

  const retryAgainstVerifiedHead = () => {
    if (!staleHeadRevision) return;
    setHeadRevision(staleHeadRevision);
    setStaleHeadRevision(null);
    setRetryReady(false);
    setPublishMessage(
      `${session ? "Retrying" : "Local preview retry"} against ${staleHeadRevision}. Your choices are still in the draft.`,
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
                  ? "Loading Environment…"
                  : (action?.title ?? "Variables are hidden")}
              </h2>
            </CardTitle>
            <CardDescription>
              {loading
                ? "Fetching the latest verified state for this Environment."
                : (action?.body ??
                  "Enroll this browser to view and edit variables.")}
            </CardDescription>
          </CardHeader>
          {setupCommand || setupMessage ? (
            <CardContent className="space-y-3">
              {setupCommand ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Use the CLI on this machine instead of this browser:
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
                  {setupMessage}
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

      {conflictingLaneIds.size > 0 ? (
        <Card className="mb-4 border-amber-300/30">
          <CardHeader>
            <CardTitle>Someone else published these</CardTitle>
            <CardDescription>
              Pick which value to keep for each conflict, then retry.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {variables
              .filter((variable) => conflictingLaneIds.has(variable.id))
              .map((variable) => (
                <div
                  className="flex flex-col gap-3 rounded-lg border bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                  key={variable.id}
                >
                  <p className="font-mono text-sm">{variable.name}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => resolveConflict(variable.id, "local")}
                      size="sm"
                      variant="outline"
                    >
                      Keep mine
                    </Button>
                    <Button
                      disabled={remoteVariables.length === 0}
                      onClick={() => resolveConflict(variable.id, "remote")}
                      size="sm"
                      variant="outline"
                    >
                      Use theirs
                    </Button>
                    <Button
                      disabled={remoteVariables.length === 0}
                      onClick={() => resolveConflict(variable.id, "merge")}
                      size="sm"
                    >
                      Keep my value
                    </Button>
                  </div>
                </div>
              ))}
          </CardContent>
        </Card>
      ) : null}

      {retryReady && staleHeadRevision ? (
        <Alert className="mb-4 border-primary/25 bg-primary/5">
          <Check className="text-primary" />
          <AlertTitle>Ready to retry</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Your choices are saved. Publish them on top of the latest
              revision.
            </span>
            <Button onClick={retryAgainstVerifiedHead} size="sm">
              Retry publish
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
              disabled={loadPhase === "loading"}
              onClick={() => {
                setAddError(null);
                setAddOpen(true);
              }}
              size="sm"
              variant="outline"
            >
              <Plus aria-hidden="true" /> Add Variable
            </Button>
            <Button
              disabled={!canPublish}
              onClick={() => {
                setReviewValuesRevealed(true);
                setReviewOpen(true);
              }}
              size="sm"
            >
              <Save aria-hidden="true" /> Save changes
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          {variables.length === 0 ? (
            <p
              className="px-4 py-6 text-sm text-muted-foreground"
              role={loadPhase === "loading" ? "status" : undefined}
            >
              {loadPhase === "loading"
                ? "Loading Environment…"
                : "Add a Variable to start this Manifest."}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {variables.map((variable) => (
                <VariableRow
                  canUndoDelete={deletedVariableSnapshots.has(variable.id)}
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
        </CardHeader>
        <CardContent className="grid gap-2">
          {(session
            ? verifiedHistory
            : [headRevision, "rev_0183", "rev_0182"]
          ).map((revision) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              key={revision}
            >
              <div>
                <p className="font-mono text-sm">{revision}</p>
                <p className="text-xs text-muted-foreground">
                  {revision === headRevision ? "Current" : "Earlier revision"}
                </p>
              </div>
              {revision === headRevision ? (
                <Badge>Current</Badge>
              ) : (
                <Button
                  onClick={() => {
                    void openRollback(revision);
                  }}
                  size="sm"
                  variant="outline"
                >
                  <RotateCcw aria-hidden="true" /> Rollback
                </Button>
              )}
            </div>
          ))}
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
          if (open) setReviewValuesRevealed(true);
        }}
        open={reviewOpen}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Save changes</DialogTitle>
            <DialogDescription>
              These Variables will be published as a new revision.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button
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
          if (!open) {
            setRollbackTarget(null);
            setRollbackHistoricalValues(new Map());
          }
        }}
        open={rollbackTarget !== null}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Rollback</DialogTitle>
            <DialogDescription>
              Restore these variables from an earlier revision. This writes a
              new revision. It does not delete the current one.
            </DialogDescription>
          </DialogHeader>
          {pendingRollbackDiffs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is different from this revision.
            </p>
          ) : (
            <>
              <div className="flex justify-end">
                <Button
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
                {pendingRollbackDiffs.map((diff) => (
                  <label
                    className="flex items-start gap-3 rounded-lg border p-3"
                    key={diff.id}
                  >
                    <input
                      checked={rollbackLanes.has(diff.id)}
                      className="mt-1"
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
                    <ValueDiffLines
                      diff={diff}
                      revealed={rollbackValuesRevealed}
                    />
                  </label>
                ))}
              </div>
            </>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={rollbackLanes.size === 0} onClick={applyRollback}>
              Stage rollback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
