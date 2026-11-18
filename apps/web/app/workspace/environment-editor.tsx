"use client";

import {
  changedVariableIdsFromSyncPage,
  createPublicationArtifacts,
  type ProtocolTransport,
  ProtocolTransportError,
  PublicationUncertainError,
  PublicationTerminalError,
  PublicationJournalError,
  type PublicationContext,
  type RevisionSigningTrust,
  type SyncPageWire,
  sha384,
  UnreadableLaneError,
  verifySyncPage,
} from "@dotrelay/client";
import {
  Check,
  Download,
  Eye,
  EyeOff,
  FileUp,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyableCommand } from "@/components/copyable-command";
import { CommandText } from "@/components/inline-command";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { serializeDotenv } from "@/lib/dotenv";
import { applyDotenvImport } from "@/lib/dotenv-import";
import {
  type EnvironmentContextIdentity,
  environmentContextKey,
  sessionMatchesContext,
} from "@/lib/environment-context";
import {
  AddVariableDialog,
  type AddVariableState,
  ConflictLane,
  displayRevisionId,
  headFromContext,
  type MemberNames,
  nextVariableId,
  RevisionIdentity,
  revisionNumber,
  sessionSigningTrust,
  ValueDiffLines,
  VariableRow,
  verifiedRevisionsFromPage,
} from "@/lib/environment-editor-views";
import {
  DownloadDotenvDialog,
  dotenvFileName,
  downloadTextFile,
  ImportDotenvDialog,
} from "@/lib/environment-editor-tools";
import {
  advanceDraftBase,
  applyConflictResolution,
  applyRollbackToVariables,
  bareVerifiedRevision,
  type ConflictResolution,
  canActorChangeDefinitions,
  canActorChangeVariableValue,
  canActorPublishVariable,
  changedLaneCount,
  createEnvironmentVariable,
  createRollbackPlan,
  type DraftBase,
  deleteEnvironmentVariable,
  draftBaseFromRemote,
  draftValueDiffs,
  type EditorActor,
  type EnvironmentVariable,
  loadRollbackHistory,
  locallyPublishedRevision,
  mergeDraftVariablesOverRemote,
  mergeVerifiedHistory,
  prepareEncryptedPublication,
  publicationAuthoredAtNotBeforeMs,
  publicationMutationForHead,
  publishedBaseline,
  type RollbackHistoryResolution,
  readOnlyReason,
  rebaseDraftOntoRemote,
  reconcileDraftWithPermissions,
  roleLabel,
  rollbackValueDiffs,
  type SetupAction,
  settlePublishedDraft,
  summarizeConflict,
  trustedHistoryVerification,
  updateVariableValue,
  type VerifiedRevision,
  validateVariableDraft,
  variableHasDraftChange,
  verifiedPageEpochState,
  verifiedParentEpoch,
} from "@/lib/environment-workflow";
import { publishFailureMessage } from "@/lib/publish-errors";
import { cn } from "@/lib/utils";
import type { MembershipRole } from "@/lib/workspace-boundary";

type EnvironmentEditorProps = Readonly<{
  readonly available: boolean;
  readonly active?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly contextIdentity: EnvironmentContextIdentity;
  readonly role: MembershipRole;
  /** The environment's label, used to name a downloaded .env file. */
  readonly environmentLabel?: string | undefined;
  /** Team members' display names by User id, for revision authors. */
  readonly memberNames?: MemberNames | undefined;
  readonly onDraftDirtyChange?: (
    dirty: boolean,
    changedVariableNames: readonly string[],
  ) => void;
  readonly setupAction?: SetupAction | null | undefined;
  readonly setupCommand?: string | undefined;
  readonly setupMessage?: string | null | undefined;
  readonly setupBusy?: boolean | undefined;
  readonly onSetupAction?: (() => void) | undefined;
  /** Opens the Team's Members view, where a teammate can be confirmed. */
  readonly onOpenMembers?: (() => void) | undefined;
  readonly protocolSession?:
    | Readonly<{
        readonly context: PublicationContext;
        readonly transport: ProtocolTransport;
        readonly projectKeyBlocked?: "unconfirmed-sharer";
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
export const EnvironmentEditor = ({
  available,
  active,
  loading,
  contextIdentity,
  role,
  environmentLabel,
  memberNames,
  onDraftDirtyChange,
  setupAction,
  setupCommand,
  setupMessage,
  setupBusy,
  onSetupAction,
  onOpenMembers,
  protocolSession,
}: EnvironmentEditorProps) => {
  const session =
    protocolSession &&
    sessionMatchesContext(protocolSession.context, contextIdentity)
      ? protocolSession
      : null;
  const actorUserId = session?.context.actorUserId ?? null;
  // A teammate's shared key is waiting for the user to confirm that teammate.
  const waitingOnSharerConfirmation =
    session?.projectKeyBlocked === "unconfirmed-sharer";
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
  const [nameFilter, setNameFilter] = useState("");
  const [panel, setPanel] = useState<"variables" | "history">("variables");
  const [importOpen, setImportOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
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
  // The last message a failed load showed, so a later successful load can
  // take it down without clearing an unrelated publish message.
  const loadErrorMessageRef = useRef<string | null>(null);
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
  // The remote version each drafted lane was edited from. It survives a
  // session swap (a boundary refresh onto a new head), so a reload can tell a
  // teammate's concurrent change apart from a lane only this draft touched.
  const draftBaseRef = useRef<DraftBase | null>(null);
  const variablesRef = useRef(variables);
  variablesRef.current = variables;
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
  // loadAttempt is a retry trigger whose value is intentionally not read inside the effect
  useEffect(() => {
    if (!session || !available) return;
    let cancelled = false;
    const load = async () => {
      setLoadPhase("loading");
      setAddOpen(false);
      let stage: "fetch" | "verify" | "decrypt" = "fetch";
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
        stage = "verify";
        await verifySyncPage(page, sessionSigningTrust(session), {
          actorUserId: context.actorUserId,
          expectedTrustedRevisionId: context.trustedRevisionId,
          expectedTrustedRevisionHash: context.trustedRevisionHash,
          expectedContext: {
            serverProfileId: context.serverProfileId,
            teamId: context.teamId,
            projectId: context.projectId,
          },
        });
        if (cancelled) return;
        const epochState = verifiedPageEpochState(page, context.projectEpoch);
        if (epochState !== "current") {
          setPublishMessage(
            epochState === "rotated"
              ? "This project's keys were rotated while it was open. Reload to read it with the new key."
              : "The server reports an older project key than this environment's own history. No values were shown or changed. Don't publish from this browser until you've checked the server.",
          );
          setLoadPhase("failed");
          return;
        }
        stage = "decrypt";
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
        const rebased = rebaseDraftOntoRemote(
          variablesRef.current,
          draftBaseRef.current,
          decoded,
        );
        draftBaseRef.current = rebased.base;
        setRemoteVariables(decoded);
        setVariables([...rebased.variables]);
        if (rebased.conflictVariableIds.length > 0) {
          setConflictLaneIds(new Set(rebased.conflictVariableIds));
          setConflictChoices(new Map());
          setConflictValuesRevealed(false);
          setStaleHeadRevision(
            page.currentHeadId ?? context.expectedHeadId ?? "empty-environment",
          );
          setReviewOpen(false);
          setPublishMessage(
            "Someone else changed variables you are editing. Compare both versions, pick what to keep, then publish.",
          );
        }
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
        if (!cancelled) {
          const staleError = loadErrorMessageRef.current;
          loadErrorMessageRef.current = null;
          if (staleError)
            setPublishMessage((current) =>
              current === staleError ? null : current,
            );
          setLoadPhase("ready");
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof UnreadableLaneError
              ? error.reason === "unconfirmed-legacy-author"
                ? "A value in this environment was last published in an older format by a teammate this browser hasn't confirmed. Compare their fingerprint in Members and confirm it, or ask a teammate to publish the value again. Your values have not been changed."
                : error.laneKind === "USER_DEFINED_VALUE"
                  ? "This browser can open the account, but not a user-defined value in this environment. Open DotRelay on the device that last published it and run `dotrelay pull`, then retry here. Your values have not been changed."
                  : session.projectKeyBlocked === "unconfirmed-sharer"
                    ? "A teammate shared this project's keys with you. This browser uses them once you confirm that teammate's fingerprint in Members."
                    : "This browser can open the account, but not this project's values. On a device that can still read this project, run `dotrelay pull` to publish its key for recovery, then retry here. Your values have not been changed."
              : stage === "fetch"
                ? "The server couldn't send this environment. Check your connection and retry; no values were changed."
                : stage === "verify"
                  ? "The environment response failed integrity verification. No values were shown or changed. Retry, and contact the server administrator if it persists."
                  : "This browser couldn't decrypt the verified environment. Open Recovery to check this account's key, then retry. No values were changed.";
          loadErrorMessageRef.current = message;
          setPublishMessage(message);
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
  // Re-reads the verified head on demand. The read rebases the draft onto
  // it, so unpublished edits are kept and a teammate's change to a drafted
  // Variable comes back as a conflict instead of being overwritten.
  const refreshRead = () => {
    if (loadPhase !== "ready" || publishing) return;
    setPublishMessage(null);
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
  const finalizeStartedRef = useRef(false);
  useEffect(
    () => () => {
      const inFlight = inFlightOperationRef.current;
      if (
        inFlight &&
        !operationFinalizedRef.current &&
        !finalizeStartedRef.current
      )
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
    setImportOpen(false);
    setDownloadOpen(false);
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
        const recovered = await publishSession.transport.recoverPublication?.();
        if (recovered) {
          setPublishMessage(
            `Your earlier publication went through as revision ${displayRevisionId(String(recovered.revisionId))}. Loading it now.`,
          );
          setLoadAttempt((attempt) => attempt + 1);
          return;
        }
        const context = publishSession.context;
        const expectedHeadId = protocolHead?.id ?? context.expectedHeadId;
        const expectedHeadHash = protocolHead?.hash ?? context.expectedHeadHash;
        const mutation = publicationMutationForHead({
          expectedHeadId,
          rollbackTargetId: rollbackMutationTarget,
        });
        const authoredAtNotBeforeMs = publicationAuthoredAtNotBeforeMs(
          context.authoredAtNotBeforeMs,
          expectedHeadId,
          verifiedHistory,
        );
        const artifacts = await createPublicationArtifacts(publishVariables, {
          ...context,
          expectedHeadId,
          expectedHeadHash,
          // Never seal under an older epoch than the verified head's.
          ...verifiedParentEpoch(verifiedHistory, expectedHeadId),
          mutation,
          ...(authoredAtNotBeforeMs === undefined
            ? {}
            : { authoredAtNotBeforeMs }),
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
        finalizeStartedRef.current = false;
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
          finalizeStartedRef.current = true;
          await publishSession.transport.finalize({
            operationId,
            deviceId: context.actorDeviceId,
            request: artifacts.request,
          });
        } catch (error) {
          if (error instanceof PublicationUncertainError) throw error;
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
                changedVariableIds: publishVariables
                  .filter((variable) => variable.hasDraftChange)
                  .map((variable) => variable.id),
              }),
            ]),
          );
        }
        setVariables((current) =>
          settlePublishedDraft(current, publishVariables),
        );
        setDeletedVariableSnapshots(new Map());
        setRemoteVariables(publishedBaseline(publishVariables));
        draftBaseRef.current = draftBaseFromRemote(publishVariables);
        setRollbackMutationTarget(null);
        clearConflictState();
        setReviewOpen(false);
        {
          const published = publishVariables.filter(
            (variable) => variable.hasDraftChange,
          ).length;
          setPublishMessage(
            `Published ${published} ${published === 1 ? "change" : "changes"}${environmentLabel ? ` to ${environmentLabel}` : ""} as revision ${displayRevisionId(artifacts.request.revision.id)}.`,
          );
        }
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
      draftBaseRef.current = draftBaseFromRemote(publishVariables);
      clearConflictState();
      setReviewOpen(false);
      setPublishMessage(
        `Local preview saved as rev_${String(nextRevision).padStart(4, "0")}.`,
      );
    } catch (error) {
      if (error instanceof PublicationJournalError) {
        setPublishMessage(error.message);
        return;
      }
      if (error instanceof PublicationTerminalError) {
        setPublishMessage(
          "The original publication expired or was cancelled without committing. Review your draft before publishing again.",
        );
        return;
      }
      if (error instanceof PublicationUncertainError) {
        setPublishMessage(
          "Publication outcome is unknown. Retry to reconcile the original operation; no new Revision will be created until it is resolved.",
        );
        return;
      }
      if (
        publishSession &&
        error instanceof ProtocolTransportError &&
        error.problem.code === "stale_head"
      ) {
        if (scopeLost()) {
          setPublishMessage(
            "Someone else updated this environment first, so nothing was published. Your draft is kept. Open the environment again and try again.",
          );
          return;
        }
        try {
          const context = publishSession.context;
          const trustedRevisionId =
            protocolHead?.id ??
            context.expectedHeadId ??
            context.trustedRevisionId ??
            context.environmentId;
          const trustedRevisionHash =
            protocolHead?.hash ??
            context.expectedHeadHash ??
            context.trustedRevisionHash ??
            new Uint8Array(48);
          const page = await publishSession.transport.syncAll({
            environmentId: context.environmentId,
            deviceId: context.actorDeviceId,
            request: {
              trustedRevisionId,
              trustedRevisionHash,
              pagination: {},
            },
          });
          // An incremental page: no Revision may reuse an id this browser
          // already verified or predate the head it continues from.
          await verifySyncPage(page, sessionSigningTrust(publishSession), {
            actorUserId: context.actorUserId,
            expectedTrustedRevisionId: trustedRevisionId,
            expectedTrustedRevisionHash: trustedRevisionHash,
            expectedContext: {
              serverProfileId: context.serverProfileId,
              teamId: context.teamId,
              projectId: context.projectId,
            },
            ...trustedHistoryVerification(verifiedHistory, trustedRevisionId),
          });
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
          if (decodedVariables)
            draftBaseRef.current = advanceDraftBase(
              draftBaseRef.current,
              decodedVariables,
              conflictingVariableIds,
            );
          // The page's Revisions join the verified history only with the
          // head they lead to: a page that fails to decode, or names no
          // head, leaves both as they were, so a retry can fetch it again.
          setVerifiedHistory((current) =>
            mergeVerifiedHistory(current, verifiedRevisionsFromPage(page)),
          );
          setProtocolHead({
            id: page.currentHeadId,
            hash: page.currentHeadHash,
          });
          setHeadRevision(page.currentHeadId);
          // Without a conflict, bring the teammate's changes to the other
          // Variables into view now, so the editor never shows (or later
          // republishes over) values that are already stale.
          if (
            decodedVariables &&
            conflictingVariableIds.length === 0 &&
            page.nextCursor === null
          )
            setVariables([
              ...mergeDraftVariablesOverRemote(
                variablesRef.current,
                decodedVariables,
              ),
            ]);
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
            "Someone else updated this environment first, and their changes couldn't be loaded. Your draft is kept. Use Refresh to load them, then try again.",
          );
        }
        return;
      }
      setPublishMessage(
        publishFailureMessage(error, {
          online: typeof navigator === "undefined" || navigator.onLine,
        }),
      );
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
    // Every conflict was resolved against the current remote, which is now
    // the base each lane was edited from.
    draftBaseRef.current = draftBaseFromRemote(remoteVariables);
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
      `Values from revision ${displayRevisionId(rollbackTarget)} are in your draft. Review and publish to save the rollback as a new revision.`,
    );
  };

  const normalizedFilter = nameFilter.trim().toLowerCase();
  // A deletion that is already published is gone, not something to undo;
  // only a deletion in this draft is listed (with its undo).
  const visibleVariables = variables.filter(
    (variable) =>
      !(variable.tombstone && !variable.hasDraftChange) &&
      (normalizedFilter === "" ||
        variable.name.toLowerCase().includes(normalizedFilter)),
  );
  const variableNames = new Map<string, string>([
    ...remoteVariables.map((variable) => [variable.id, variable.name] as const),
    ...variables.map((variable) => [variable.id, variable.name] as const),
  ]);
  const downloadableEntries = remoteVariables.flatMap((variable) =>
    !variable.tombstone && variable.value !== null
      ? [{ name: variable.name, value: variable.value }]
      : [],
  );
  const unsetDownloadCount = remoteVariables.filter(
    (variable) => !variable.tombstone && variable.value === null,
  ).length;
  const fileName = dotenvFileName(environmentLabel);
  const stageImport = (
    ...[plan, ownership]: Parameters<
      Parameters<typeof ImportDotenvDialog>[0]["onStage"]
    >
  ) => {
    if (loadPhase !== "ready") return;
    setPublishMessage(null);
    setVariables((current) =>
      applyDotenvImport(plan, current, {
        ownership,
        actorUserId,
        baselineFor,
        nextId: nextVariableId,
      }),
    );
    const staged = plan.filter(
      (action) => action.kind === "add" || action.kind === "update",
    ).length;
    setPublishMessage(
      `${staged} variable${staged === 1 ? "" : "s"} from the import ${staged === 1 ? "is" : "are"} in your draft. Review and save to publish.`,
    );
  };
  const downloadDotenv = () => {
    downloadTextFile(fileName, serializeDotenv(downloadableEntries));
    setDownloadOpen(false);
  };

  if (!available) {
    const action = setupAction;
    return (
      <section className="scroll-mt-24" id="environment">
        <div className="mx-auto max-w-3xl rounded-xl border bg-card p-6">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <LockKeyhole aria-hidden="true" className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-heading text-lg font-semibold">
                {loading
                  ? "Loading environment…"
                  : (action?.title ?? "Variables are hidden")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {loading ? (
                  "Getting the latest values for this environment."
                ) : (
                  <CommandText
                    text={
                      action?.body ??
                      "Set up this browser to view and edit its variables."
                    }
                  />
                )}
              </p>
              {setupCommand || setupMessage ? (
                <div className="mt-4 space-y-3">
                  {setupCommand ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        Prefer the CLI? It sets up the CLI, not this browser.
                      </p>
                      <CopyableCommand
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
                </div>
              ) : null}
              {action && (onSetupAction || action.id === "sign-in") ? (
                <div className="mt-5">
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
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="scroll-mt-24" id="environment">
      {publishMessage ? (
        <div
          className="mb-4 flex items-start gap-2.5 rounded-lg border border-primary/25 bg-primary/5 px-4 py-2.5 text-sm"
          role="status"
        >
          <Check
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-primary"
          />
          <span>{publishMessage}</span>
        </div>
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

      <h2 className="sr-only">
        {panel === "variables" ? "Variables" : "History"}
      </h2>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div
          aria-label="Environment view"
          className="inline-flex rounded-lg border bg-card p-0.5"
          role="tablist"
        >
          {(["variables", "history"] as const).map((candidate) => (
            <button
              aria-selected={panel === candidate}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                panel === candidate
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={candidate}
              onClick={() => setPanel(candidate)}
              role="tab"
              type="button"
            >
              {candidate === "variables" ? "Variables" : "History"}
            </button>
          ))}
        </div>
        {panel === "variables" &&
        loadPhase !== "failed" &&
        variables.length > 0 ? (
          <div className="relative min-w-40 flex-1 sm:max-w-xs">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search variables"
              className="h-8 pl-8"
              onChange={(event) => setNameFilter(event.target.value)}
              placeholder="Search variables"
              type="search"
              value={nameFilter}
            />
          </div>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {loadPhase === "failed" && !waitingOnSharerConfirmation ? (
            <Button
              data-testid="environment-retry-read"
              onClick={retryRead}
              size="sm"
              variant="outline"
            >
              <RotateCcw aria-hidden="true" /> Try again
            </Button>
          ) : null}
          <Button
            disabled={loadPhase !== "ready" || !canChangeDefinitions}
            onClick={() => {
              setPanel("variables");
              setAddError(null);
              setAddOpen(true);
            }}
            size="sm"
          >
            <Plus aria-hidden="true" /> Add variable
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="More actions"
                  size="icon-sm"
                  variant="outline"
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={loadPhase !== "ready"}
                onClick={() => setImportOpen(true)}
              >
                <FileUp aria-hidden="true" /> Import from a .env file
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={
                  loadPhase !== "ready" || downloadableEntries.length === 0
                }
                onClick={() => setDownloadOpen(true)}
              >
                <Download aria-hidden="true" /> Download as a .env file
              </DropdownMenuItem>
              {session && loadPhase !== "failed" ? (
                <DropdownMenuItem
                  disabled={loadPhase !== "ready" || publishing}
                  onClick={refreshRead}
                >
                  <RefreshCw aria-hidden="true" /> Load latest values
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {!canChangeDefinitions ? (
        <p
          className="mb-3 text-sm text-muted-foreground"
          data-testid="member-permissions-note"
        >
          As a {roleLabel(role).toLowerCase()}, you can see every variable. You
          can edit your own &ldquo;Only me&rdquo; values and team values you
          added. Owners and admins can edit the rest, and add or remove
          variables.
        </p>
      ) : null}

      {panel === "variables" ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          {variables.length === 0 ? (
            loadPhase === "loading" ? (
              <p
                className="px-4 py-6 text-sm text-muted-foreground"
                role="status"
              >
                Loading environment…
              </p>
            ) : loadPhase === "failed" && waitingOnSharerConfirmation ? (
              <div
                className="px-6 py-10 text-center"
                data-testid="environment-awaiting-confirmation"
              >
                <p className="font-medium">
                  Confirm your teammate to see these values
                </p>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  Compare fingerprints with the teammate who shared the keys,
                  then confirm them in Members. The values load here as soon as
                  you do.
                </p>
                {onOpenMembers ? (
                  <Button className="mt-4" onClick={onOpenMembers} size="sm">
                    Open Members
                  </Button>
                ) : null}
              </div>
            ) : loadPhase === "failed" ? (
              <p
                className="px-4 py-6 text-sm text-muted-foreground"
                data-testid="environment-read-failed"
                role="status"
              >
                This environment couldn&apos;t be loaded, so its variables are
                hidden. Select Try again to reload it.
              </p>
            ) : (
              <div className="px-6 py-12 text-center">
                <p className="font-medium">No variables yet</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  Add one here, import a .env file, or run{" "}
                  <code className="font-mono">dotrelay push</code> in the
                  repository.
                </p>
              </div>
            )
          ) : (
            <>
              <div
                aria-hidden="true"
                className="hidden grid-cols-[minmax(0,2fr)_minmax(0,3fr)_6rem] gap-3 border-b bg-sidebar px-4 py-2 text-xs font-medium text-muted-foreground md:grid"
              >
                <span>Name</span>
                <span>Value</span>
                <span>Visible to</span>
              </div>
              <ul className="divide-y divide-border">
                {visibleVariables.length === 0 ? (
                  <li
                    className="px-4 py-6 text-sm text-muted-foreground"
                    role="status"
                  >
                    No variables match “{nameFilter.trim()}”.
                  </li>
                ) : null}
                {visibleVariables.map((variable) => (
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
                            ? withDraftFlag(
                                updateVariableValue(candidate, null),
                              )
                            : candidate,
                        ),
                      )
                    }
                    onToggleReveal={() => toggleReveal(variable.id)}
                    onUndoDelete={() => undoDelete(variable.id)}
                    onValueChange={(value) => updateValue(variable.id, value)}
                    readOnlyDisclosure={readOnlyReason(actor, variable)}
                    othersPrivate={
                      variable.ownership === "USER_DEFINED_VALUE" &&
                      variable.value === null &&
                      typeof variable.ownerUserId === "string" &&
                      variable.ownerUserId.length > 0 &&
                      variable.ownerUserId !== actorUserId
                    }
                    revealed={revealed.has(variable.id)}
                    variable={variable}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {historyRows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              Nothing has been published yet. Each publish shows up here, so you
              can see what changed and roll back.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {[...historyRows].reverse().map((revision) => {
                const isCurrent = revision.id === headRevision;
                const rollbackTargetId = revision.rollbackTargetId;
                const rollbackTargetKnown =
                  rollbackTargetId !== null &&
                  historyRows.some((entry) => entry.id === rollbackTargetId);
                return (
                  <li
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    data-testid={`history-revision-${revision.id}`}
                    key={revision.id}
                  >
                    <div className="min-w-0">
                      <RevisionIdentity
                        actorUserId={session?.context.actorUserId}
                        memberNames={memberNames}
                        variableNames={variableNames}
                        lineSuffix={
                          rollbackTargetId !== null
                            ? `. Rolled back to ${rollbackTargetKnown ? displayRevisionId(rollbackTargetId) : "an earlier revision"}`
                            : null
                        }
                        revision={revision}
                      />
                    </div>
                    {isCurrent ? (
                      <Badge
                        className="border-primary/30 bg-primary/10 text-primary"
                        variant="outline"
                      >
                        Current
                      </Badge>
                    ) : (
                      <Button
                        disabled={loadPhase !== "ready" || !canStageAnyRollback}
                        onClick={() => {
                          void openRollback(revision.id);
                        }}
                        size="sm"
                        variant="outline"
                      >
                        <RotateCcw aria-hidden="true" /> Roll back
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {active !== false && hasDirtyDraft && pendingDiffs.length > 0 ? (
        <div
          aria-label="Unpublished changes"
          className="fixed inset-x-3 bottom-3 z-30 mx-auto flex max-w-xl items-center gap-3 rounded-xl border border-border bg-popover py-2 pr-2 pl-4 shadow-2xl shadow-black/60 lg:left-64"
          data-testid="draft-bar"
          role="region"
        >
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-amber-300"
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-medium">
              {pendingDiffs.length}{" "}
              {pendingDiffs.length === 1 ? "change" : "changes"}
            </span>{" "}
            <span className="hidden text-muted-foreground sm:inline">
              not published
              {environmentLabel ? ` in ${environmentLabel}` : ""}
            </span>
          </span>
          <Button
            disabled={!canPublish}
            onClick={() => {
              setReviewValuesRevealed(false);
              setReviewOpen(true);
            }}
            size="sm"
          >
            Review and publish
          </Button>
        </div>
      ) : null}

      <ImportDotenvDialog
        actor={actor}
        onOpenChange={setImportOpen}
        onStage={stageImport}
        open={importOpen}
        variables={variables}
      />

      <DownloadDotenvDialog
        fileName={fileName}
        hasDraft={hasDirtyDraft}
        onDownload={downloadDotenv}
        onOpenChange={setDownloadOpen}
        open={downloadOpen}
        unsetCount={unsetDownloadCount}
        valueCount={downloadableEntries.length}
      />

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
            <DialogTitle>
              Publish {pendingDiffs.length}{" "}
              {pendingDiffs.length === 1 ? "change" : "changes"}
              {environmentLabel ? ` to ${environmentLabel}` : ""}
            </DialogTitle>
            <DialogDescription>
              This saves a new revision. Teammates get team values the next time
              they pull. &ldquo;Only me&rdquo; values stay visible to you only.
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
            <DialogTitle>Roll back</DialogTitle>
            <DialogDescription>
              Choose which values to bring back from this revision. They go into
              your unpublished changes, so nothing is saved until you publish.
              Publishing adds a new revision and keeps the history.
            </DialogDescription>
          </DialogHeader>
          {rollbackTargetEntry ? (
            <div className="grid gap-1 rounded-lg border bg-muted/20 p-3">
              <RevisionIdentity
                actorUserId={session?.context.actorUserId}
                idClassName="font-mono text-sm font-medium"
                memberNames={memberNames}
                revision={rollbackTargetEntry}
                variableNames={variableNames}
              />
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
              Add to my changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
