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
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  nextVariableId,
  RevisionIdentity,
  revisionNumber,
  sessionSigningTrust,
  ValueDiffLines,
  VariableRow,
  verifiedRevisionsFromPage,
} from "@/lib/environment-editor-views";
import {
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
  roleLabel,
  rollbackValueDiffs,
  type SetupAction,
  settlePublishedDraft,
  summarizeConflict,
  updateVariableValue,
  type VerifiedRevision,
  validateVariableDraft,
  variableHasDraftChange,
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
