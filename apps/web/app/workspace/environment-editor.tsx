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
  LockKeyhole,
  Plus,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { CopyableCommand } from "@/components/copyable-command";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
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
  applyRollbackToVariables,
  changedLaneCount,
  createEnvironmentVariable,
  createRollbackPlan,
  deleteEnvironmentVariable,
  type EnvironmentVariable,
  prepareEncryptedPublication,
  type SetupAction,
  updateVariableValue,
  type VariableDraft,
  validateVariableDraft,
} from "@/lib/environment-workflow";

type EnvironmentEditorProps = Readonly<{
  readonly available: boolean;
  readonly setupAction?: SetupAction | null;
  readonly setupCommand?: string;
  readonly setupMessage?: string | null;
  readonly setupBusy?: boolean;
  readonly onSetupAction?: () => void;
  readonly environmentLabel?: string;
  readonly remoteHeadRevision: string;
  readonly protocolSession?: Readonly<{
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
  }>;
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

const nextVariableId = (): string => globalThis.crypto.randomUUID();

const revisionNumber = (revision: string): number =>
  Number.parseInt(revision.replace("rev_", ""), 10);

const valueStateLabel = (variable: EnvironmentVariable): string => {
  if (variable.tombstone) return "Will delete";
  if (variable.value === null) return "Not set";
  if (variable.value === "") return "Empty";
  return "Hidden";
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
          Name it, choose who can read it, and set the first value. Encryption
          happens in this browser.
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
  setupAction,
  setupCommand,
  setupMessage,
  setupBusy,
  onSetupAction,
  environmentLabel = "default",
  remoteHeadRevision,
  protocolSession,
}: EnvironmentEditorProps) => {
  const [variables, setVariables] = useState<EnvironmentVariable[]>(() =>
    protocolSession ? [] : [...initialVariables],
  );
  const [remoteVariables, setRemoteVariables] = useState<
    readonly EnvironmentVariable[]
  >(() => (protocolSession ? [] : initialVariables));
  const [headRevision, setHeadRevision] = useState(
    protocolSession?.context.expectedHeadId ?? "rev_0184",
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
  }> | null>(() =>
    protocolSession?.context.expectedHeadId &&
    protocolSession.context.expectedHeadHash
      ? {
          id: protocolSession.context.expectedHeadId,
          hash: protocolSession.context.expectedHeadHash,
        }
      : null,
  );
  const [rollbackMutationTarget, setRollbackMutationTarget] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (!protocolSession) return;
    setVariables((current) =>
      current.some((variable) => variable.hasDraftChange) ? current : [],
    );
    setRemoteVariables([]);
    setHeadRevision(
      protocolSession.context.expectedHeadId ?? "empty-environment",
    );
    setVerifiedHistory([]);
    setProtocolHead(
      protocolSession.context.expectedHeadId &&
        protocolSession.context.expectedHeadHash
        ? {
            id: protocolSession.context.expectedHeadId,
            hash: protocolSession.context.expectedHeadHash,
          }
        : null,
    );
  }, [protocolSession]);
  useEffect(() => {
    if (!protocolSession || !available) return;
    let cancelled = false;
    const load = async () => {
      try {
        const context = protocolSession.context;
        if (!context.trustedRevisionId || !context.trustedRevisionHash) return;
        const page = await protocolSession.transport.syncAll({
          environmentId: context.environmentId,
          deviceId: context.actorDeviceId,
          request: {
            trustedRevisionId: context.trustedRevisionId,
            trustedRevisionHash: context.trustedRevisionHash,
            pagination: {},
          },
        });
        await verifySyncPage(page, sessionTrustKeys(protocolSession), {
          actorUserId: context.actorUserId,
        });
        if (cancelled) return;
        const decoded = protocolSession.decodeVariables
          ? await protocolSession.decodeVariables(page, [])
          : undefined;
        if (cancelled || !decoded) return;
        setRemoteVariables(decoded);
        setVariables((current) =>
          current.some((variable) => variable.hasDraftChange)
            ? current
            : [...decoded],
        );
        setVerifiedHistory(page.revisions.map((revision) => revision.id));
        if (page.currentHeadId && page.currentHeadHash) {
          setProtocolHead({
            id: page.currentHeadId,
            hash: page.currentHeadHash,
          });
          setHeadRevision(page.currentHeadId);
        }
      } catch {
        if (!cancelled)
          setPublishMessage(
            "This Device could not read the current Environment.",
          );
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [protocolSession, available]);
  const [deletedVariableSnapshots, setDeletedVariableSnapshots] = useState<
    ReadonlyMap<string, EnvironmentVariable>
  >(() => new Map());
  const changedCount = changedLaneCount(variables);
  const canPublish =
    changedCount > 0 &&
    conflictingLaneIds.size === 0 &&
    staleHeadRevision === null &&
    !publishing;
  const historicalValues = new Map<string, string | null>([
    ["00000000-0000-4000-8000-000000000001", ""],
    ["00000000-0000-4000-8000-000000000002", ""],
    ["00000000-0000-4000-8000-000000000003", null],
  ]);

  const updateValue = (id: string, value: string) => {
    setPublishMessage(null);
    setVariables((current) =>
      current.map((variable) =>
        variable.id === id ? updateVariableValue(variable, value) : variable,
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
          ? { ...snapshot, hasDraftChange: true, tombstone: false }
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

  const openRollback = (revision: string) => {
    setRollbackTarget(revision);
    setRollbackLanes(new Set(variables.map((variable) => variable.id)));
  };

  const publish = async () => {
    if (changedCount === 0) return;
    setPublishing(true);
    try {
      if (protocolSession) {
        const context = protocolSession.context;
        const expectedHeadId = protocolHead?.id ?? context.expectedHeadId;
        const expectedHeadHash = protocolHead?.hash ?? context.expectedHeadHash;
        const artifacts = await createPublicationArtifacts(variables, {
          ...context,
          expectedHeadId,
          expectedHeadHash,
          ...(rollbackMutationTarget
            ? {
                mutation: "ROLLBACK" as const,
                rollbackTargetId: rollbackMutationTarget,
                rollbackSelectedVariableIds: [...rollbackLanes],
              }
            : {}),
        });
        const operationId = globalThis.crypto.randomUUID();
        await protocolSession.transport.begin({
          operationId,
          deviceId: context.actorDeviceId,
          kind:
            rollbackMutationTarget || context.mutation === "ROLLBACK"
              ? "ROLLBACK"
              : "REVISION_PUBLICATION",
          commandBytes: artifacts.commandBytes,
          commandDigest: await sha384(artifacts.commandBytes),
        });
        try {
          for (const staged of artifacts.stagedObjects)
            await protocolSession.transport.stage({
              operationId,
              deviceId: context.actorDeviceId,
              objectId: staged.objectId,
              bytes: staged.bytes,
            });
          await protocolSession.transport.finalize({
            operationId,
            deviceId: context.actorDeviceId,
            request: artifacts.request,
          });
        } catch (error) {
          await protocolSession.transport
            .cancel({
              operationId,
              deviceId: context.actorDeviceId,
            })
            .catch(() => undefined);
          throw error;
        }
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
        setPublishMessage(
          `Published as ${artifacts.request.revision.id}. ${artifacts.encryptedLaneCount} encrypted lane${artifacts.encryptedLaneCount === 1 ? "" : "s"} (${artifacts.encryptedBytes} bytes); ${artifacts.tombstoneLaneCount} tombstone${artifacts.tombstoneLaneCount === 1 ? "" : "s"}; service plaintext 0 bytes.`,
        );
        return;
      }
      const preparation = await prepareEncryptedPublication(variables);
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
        `Local cryptographic preview completed as rev_${String(nextRevision).padStart(4, "0")}. ${preparation.encryptedLaneCount} changed lane${preparation.encryptedLaneCount === 1 ? " was" : "s were"} encrypted (${preparation.encryptedBytes} bytes), and ${preparation.tombstoneLaneCount} tombstone${preparation.tombstoneLaneCount === 1 ? " was" : "s were"} signed (${preparation.signatureBytes} bytes). No service publication occurred because this workspace has no live protocol session.`,
      );
    } catch (error) {
      if (
        protocolSession &&
        error instanceof ProtocolTransportError &&
        error.problem.code === "stale_head"
      ) {
        try {
          const context = protocolSession.context;
          const page = await protocolSession.transport.syncAll({
            environmentId: context.environmentId,
            deviceId: context.actorDeviceId,
            request: {
              trustedRevisionId:
                protocolHead?.id ?? context.expectedHeadId ?? "",
              trustedRevisionHash:
                protocolHead?.hash ??
                context.expectedHeadHash ??
                new Uint8Array(48),
              pagination: {},
            },
          });
          await verifySyncPage(page, sessionTrustKeys(protocolSession), {
            actorUserId: context.actorUserId,
          });
          setVerifiedHistory(page.revisions.map((revision) => revision.id));
          const remoteChangedVariableIds = changedVariableIdsFromSyncPage(page);
          const decodedVariables = protocolSession.decodeVariables
            ? await protocolSession.decodeVariables(page, remoteVariables)
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
              ? "Publication was not committed because the verified head changed on overlapping lanes. Resolve them, then retry."
              : "Publication was not committed, but the verified head changed on other lanes; the local draft remains publishable.",
          );
        } catch {
          setPublishMessage(
            "Publication stopped after a stale head response. The verified head could not be synchronized.",
          );
        }
        return;
      }
      setPublishMessage(
        "Publication stopped because the verified server rejected the draft.",
      );
    } finally {
      setPublishing(false);
    }
  };

  const applyRollback = async () => {
    if (!rollbackTarget || rollbackLanes.size === 0) return;
    try {
      createRollbackPlan(rollbackTarget, [...rollbackLanes]);
      const rollbackValues = protocolSession
        ? protocolSession.resolveRollbackValues
          ? await protocolSession.resolveRollbackValues({
              targetRevision: rollbackTarget,
              selectedVariableIds: [...rollbackLanes],
            })
          : null
        : historicalValues;
      if (!rollbackValues)
        throw new Error(
          "verified historical Values are unavailable for this live session",
        );
      const nextVariables = applyRollbackToVariables(
        variables,
        rollbackValues,
        [...rollbackLanes],
      );
      setVariables([...nextVariables]);
    } catch {
      setPublishMessage(
        "Rollback stopped because verified historical state is unavailable.",
      );
      return;
    }
    setRollbackTarget(null);
    setRollbackMutationTarget(rollbackTarget);
    setPublishMessage(
      `Rollback staged from ${rollbackTarget}. This will append a new Revision; ${headRevision} remains in history.`,
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
      `${protocolSession ? "Retrying" : "Local preview retry"} against verified head ${staleHeadRevision}. The local choices remain in the draft.`,
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
              <h2>{action?.title ?? "Variables are hidden"}</h2>
            </CardTitle>
            <CardDescription>
              {action?.body ??
                "Enroll this browser to view and edit variables."}
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
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-heading text-2xl font-semibold">Variables</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {environmentLabel}. Values stay on this Device.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={async () => {
              if (protocolSession) {
                try {
                  const context = protocolSession.context;
                  if (
                    (context.expectedHeadId && !context.expectedHeadHash) ||
                    !context.trustedRevisionId ||
                    !context.trustedRevisionHash
                  )
                    throw new Error(
                      "a verified head is required before synchronization",
                    );
                  const useGenesisTrust = remoteVariables.length === 0;
                  const trustedRevisionId = context.trustedRevisionId;
                  const trustedRevisionHash = context.trustedRevisionHash;
                  const syncTrustedRevisionId = useGenesisTrust
                    ? trustedRevisionId
                    : (protocolHead?.id ?? context.expectedHeadId);
                  const syncTrustedRevisionHash = useGenesisTrust
                    ? trustedRevisionHash
                    : (protocolHead?.hash ?? context.expectedHeadHash);
                  if (!syncTrustedRevisionId || !syncTrustedRevisionHash)
                    throw new Error(
                      "a verified synchronization anchor is unavailable",
                    );
                  const page = await protocolSession.transport.syncAll({
                    environmentId: context.environmentId,
                    deviceId: context.actorDeviceId,
                    request: {
                      trustedRevisionId: syncTrustedRevisionId,
                      trustedRevisionHash: syncTrustedRevisionHash,
                      pagination: {},
                    },
                  });
                  await verifySyncPage(
                    page,
                    sessionTrustKeys(protocolSession),
                    {
                      actorUserId: context.actorUserId,
                    },
                  );
                  setVerifiedHistory(
                    page.revisions.map((revision) => revision.id),
                  );
                  const remoteChangedVariableIds =
                    changedVariableIdsFromSyncPage(page);
                  const decodedVariables = protocolSession.decodeVariables
                    ? await protocolSession.decodeVariables(
                        page,
                        remoteVariables,
                      )
                    : undefined;
                  if (decodedVariables) {
                    setRemoteVariables(decodedVariables);
                    if (changedCount === 0) setVariables([...decodedVariables]);
                  }
                  if (page.currentHeadId && page.currentHeadHash) {
                    const localHeadId =
                      protocolHead?.id ?? context.expectedHeadId;
                    const headChanged =
                      localHeadId !== null &&
                      localHeadId !== page.currentHeadId;
                    setProtocolHead({
                      id: page.currentHeadId,
                      hash: page.currentHeadHash,
                    });
                    setHeadRevision(page.currentHeadId);
                    if (headChanged && changedCount > 0) {
                      const localChangedVariableIds = variables
                        .filter((variable) => variable.hasDraftChange)
                        .map((variable) => variable.id);
                      const conflictingVariableIds =
                        page.nextCursor !== null
                          ? localChangedVariableIds
                          : localChangedVariableIds.filter((id) =>
                              remoteChangedVariableIds.has(id),
                            );
                      setConflictingLaneIds(new Set(conflictingVariableIds));
                      setStaleHeadRevision(
                        conflictingVariableIds.length > 0
                          ? page.currentHeadId
                          : null,
                      );
                      setRetryReady(false);
                      setPublishMessage(
                        conflictingVariableIds.length > 0
                          ? "The verified server head changed on overlapping lanes. Choose a three-way resolution before retrying."
                          : "The verified server head changed on other lanes; the local draft remains publishable against the verified head.",
                      );
                      return;
                    }
                  }
                  setPublishMessage(
                    "Verified synchronization completed; no plaintext was requested.",
                  );
                  return;
                } catch {
                  setPublishMessage(
                    "Synchronization stopped because verified history could not be read.",
                  );
                  return;
                }
              }
              setConflictingLaneIds(
                new Set(
                  variables
                    .filter((variable) => variable.hasDraftChange)
                    .map((variable) => variable.id),
                ),
              );
              setPublishMessage(
                changedCount > 0
                  ? "Local preview: the server head changed while this draft was open. Choose a local three-way resolution."
                  : "Head verified against the local trust store.",
              );
              if (changedCount > 0 && remoteHeadRevision !== headRevision) {
                setStaleHeadRevision(remoteHeadRevision);
                setRetryReady(false);
              } else {
                setStaleHeadRevision(null);
                setRetryReady(false);
              }
            }}
            variant="outline"
          >
            <RefreshCcw aria-hidden="true" /> Sync &amp; verify
          </Button>
          <Button disabled={!canPublish} onClick={() => setReviewOpen(true)}>
            <ShieldCheck aria-hidden="true" /> Review &amp; publish
          </Button>
        </div>
      </div>

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-primary" /> Current revision
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {headRevision}
          </p>
        </div>
        <div className="rounded-lg border bg-card/50 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <GitBranch className="size-4" /> Local draft
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {changedCount === 0
              ? "No unpublished changes"
              : `${changedCount} unpublished change${changedCount === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="rounded-lg border bg-card/50 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <LockKeyhole className="size-4 text-primary" /> Device
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Values stay on this browser.
          </p>
        </div>
      </div>

      {publishMessage ? (
        <Alert className="mb-4 bg-card/60">
          <Check className="text-primary" />
          <AlertTitle>Draft status</AlertTitle>
          <AlertDescription>{publishMessage}</AlertDescription>
        </Alert>
      ) : null}

      {conflictingLaneIds.size > 0 ? (
        <Card className="mb-4 border-amber-300/30">
          <CardHeader>
            <CardTitle>Stale head: resolve locally</CardTitle>
            <CardDescription>
              Someone else published while you were editing. Pick what to keep
              for each conflict, then retry.
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
                  <div>
                    <p className="font-mono text-sm">{variable.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Local: hidden · Remote: hidden · choose a lane result
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => resolveConflict(variable.id, "local")}
                      size="sm"
                      variant="outline"
                    >
                      Keep local
                    </Button>
                    <Button
                      disabled={remoteVariables.length === 0}
                      onClick={() => resolveConflict(variable.id, "remote")}
                      size="sm"
                      variant="outline"
                    >
                      Use remote
                    </Button>
                    <Button
                      disabled={remoteVariables.length === 0}
                      onClick={() => resolveConflict(variable.id, "merge")}
                      size="sm"
                    >
                      Merge
                    </Button>
                  </div>
                </div>
              ))}
          </CardContent>
        </Card>
      ) : null}

      {retryReady && staleHeadRevision ? (
        <Alert className="mb-4 border-primary/25 bg-primary/5">
          <ShieldCheck className="text-primary" />
          <AlertTitle>Conflict choices are ready to retry</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Verify the new parent {staleHeadRevision} before preparing the
              signed mutation.
            </span>
            <Button onClick={retryAgainstVerifiedHead} size="sm">
              Retry against verified head
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Variables</CardTitle>
              <CardDescription>
                Names and values. Hidden until you reveal them.
              </CardDescription>
            </div>
            <Button
              onClick={() => {
                setAddError(null);
                setAddOpen(true);
              }}
            >
              <Plus aria-hidden="true" /> Add Variable
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {variables.map((variable) => {
            const isRevealed = revealed.has(variable.id);
            return (
              <div
                className="rounded-lg border bg-background/35 p-4"
                data-testid={`environment-variable-${variable.name}`}
                key={variable.id}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium">
                        {variable.name}
                      </span>
                      <Badge variant="outline">
                        {ownershipLabel(variable.ownership)}
                      </Badge>
                      {variable.hasDraftChange ? (
                        <Badge
                          className="border-amber-300/25 text-amber-200"
                          variant="outline"
                        >
                          Draft change
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {variable.description || "No description"}
                    </p>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                    {valueStateLabel(variable)}
                  </span>
                </div>
                {variable.tombstone ? (
                  <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                    <span>This Variable is marked for deletion.</span>
                    {variable.hasDraftChange &&
                    deletedVariableSnapshots.has(variable.id) ? (
                      <Button
                        onClick={() => undoDelete(variable.id)}
                        size="sm"
                        variant="outline"
                      >
                        Undo delete
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Label
                        className="sr-only"
                        htmlFor={`value-${variable.id}`}
                      >
                        {variable.name} Value
                      </Label>
                      <Input
                        autoComplete="off"
                        id={`value-${variable.id}`}
                        onChange={(event) =>
                          updateValue(variable.id, event.target.value)
                        }
                        placeholder={
                          variable.value === null ? "Absent" : "Empty Value"
                        }
                        type={isRevealed ? "text" : "password"}
                        value={variable.value ?? ""}
                      />
                      <Button
                        aria-label={`${isRevealed ? "Hide" : "Reveal"} ${variable.name}`}
                        onClick={() => toggleReveal(variable.id)}
                        size="icon"
                        variant="outline"
                      >
                        {isRevealed ? (
                          <EyeOff aria-hidden="true" />
                        ) : (
                          <Eye aria-hidden="true" />
                        )}
                      </Button>
                      <Button
                        aria-label={`Delete ${variable.name}`}
                        onClick={() => deleteVariable(variable.id)}
                        size="sm"
                        variant="ghost"
                      >
                        Delete
                      </Button>
                      {!variable.required && variable.value !== null ? (
                        <Button
                          onClick={() =>
                            setVariables((current) =>
                              current.map((candidate) =>
                                candidate.id === variable.id
                                  ? updateVariableValue(candidate, null)
                                  : candidate,
                              ),
                            )
                          }
                          size="sm"
                          variant="ghost"
                        >
                          Set absent
                        </Button>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {isRevealed
                        ? "Visible on this Device only."
                        : "Hidden until you reveal it."}
                    </p>
                  </>
                )}
              </div>
            );
          })}
        </CardContent>
        <CardFooter className="border-t text-xs text-muted-foreground">
          <LockKeyhole className="mr-2 size-3" /> The server never sees these
          values.
        </CardFooter>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <GitBranch className="size-4" /> History
          </CardTitle>
          <CardDescription>
            Past publishes. Rollback writes a new revision. The current head is
            never rewound.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {(protocolSession
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
                  {revision === headRevision
                    ? "Current verified head"
                    : "Verified historical Revision"}
                </p>
              </div>
              {revision === headRevision ? (
                <Badge>Current head</Badge>
              ) : (
                <Button
                  onClick={() => openRollback(revision)}
                  size="sm"
                  variant="outline"
                >
                  <RotateCcw aria-hidden="true" /> Rollback lanes
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

      <Dialog onOpenChange={setReviewOpen} open={reviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review &amp; publish</DialogTitle>
            <DialogDescription>
              Review metadata before the active Device encrypts changed lanes,
              signs the v3 mutation, stages objects, and finalizes publication.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Expected parent</span>
              <span className="font-mono">{headRevision}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Signing Device</span>
              <span>Current active Device</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Changed lanes</span>
              <span>{changedCount}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Service plaintext</span>
              <span className="text-primary">0 bytes</span>
            </div>
          </div>
          <div className="grid gap-2">
            {variables
              .filter((variable) => variable.hasDraftChange)
              .map((variable) => (
                <div
                  className="flex items-center justify-between rounded-lg border p-3"
                  key={variable.id}
                >
                  <div>
                    <p className="font-mono text-sm">{variable.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {variable.tombstone
                        ? "append-only tombstone"
                        : `${ownershipLabel(variable.ownership)} · fresh lane encryption`}
                    </p>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">
                    ••••••••
                  </span>
                </div>
              ))}
          </div>
          <Alert className="bg-primary/5">
            <ShieldCheck className="text-primary" />
            <AlertTitle>Ready for signed v3 mutation</AlertTitle>
            <AlertDescription>
              The expected parent and current Project epoch will be checked by
              the service. A stale head returns a reconciliation failure; it
              does not overwrite history.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={!canPublish} onClick={publish}>
              {publishing ? "Encrypting…" : "Encrypt, stage & publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
        open={rollbackTarget !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rollback selected lanes</DialogTitle>
            <DialogDescription>
              Select the lanes to restore from {rollbackTarget}. This publishes
              a new append-only Revision after {headRevision}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {variables.map((variable) => (
              <label
                className="flex items-center gap-3 rounded-lg border p-3"
                key={variable.id}
              >
                <input
                  checked={rollbackLanes.has(variable.id)}
                  onChange={(event) =>
                    setRollbackLanes((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(variable.id);
                      else next.delete(variable.id);
                      return next;
                    })
                  }
                  type="checkbox"
                />
                <span>
                  <span className="block font-mono text-sm">
                    {variable.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {ownershipLabel(variable.ownership)} · Value hidden
                  </span>
                </span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={rollbackLanes.size === 0} onClick={applyRollback}>
              Stage append-only rollback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
