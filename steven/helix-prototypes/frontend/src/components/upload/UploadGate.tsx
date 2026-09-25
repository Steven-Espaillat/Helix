"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  DATA_VALIDATION_PACKAGE_ID,
  FreezeError,
  freezeDataValidationKey,
  freezeIdempotencyKey,
  freezePinnedRun,
  manifestFingerprint,
  newAuthorizationId,
  retryFreezeDataValidation,
  type FreezeDataValidationFailure,
  type FreezeRefusal,
} from "@/lib/api/intake";
import type { Workspace } from "@/lib/types";

import { CheckIcon, FileIcon, RetryIcon, WarnIcon } from "../icons";
import { Button, Card, Chip, DataTable, GateBanner, Kicker, ListRow, toneColor } from "../ui";
import { PinnedRunDetail } from "./PinnedRunDetail";

// Lane A (#20): Human Gate 1 over the seeded manifest and the real Pinned Run freeze
// (`POST /pinned-runs`). The frozen state, the gate status, and progress all come from
// the refreshed workspace; there is no local `frozen` authority flag.

const ACTOR = "Synthetic study owner (demo identity)";

type ManifestEntry = Workspace["manifest"][number];

export function UploadGate({
  workspace,
  onRefresh,
  onKeepView,
  children,
}: {
  workspace: Workspace;
  onRefresh: () => Promise<void>;
  /** Keep this gate selected while a command it started refreshes the journey. */
  onKeepView?: () => void;
  /** Upload controls (#26), rendered only while the manifest is not frozen. */
  children?: ReactNode;
}) {
  const studyId = workspace.study.study_id;
  const upload = workspace.journey.stages.find((stage) => stage.stage_id === "upload");
  const run = workspace.pinned_run ?? null;
  const frozen = Boolean(run);
  const passed = upload?.status === "complete";
  const execution =
    (run &&
      workspace.data_validation_executions.find(
        (item) => item.receipt.run_id === run.run_id && item.receipt.package_id === DATA_VALIDATION_PACKAGE_ID,
      )) ||
    null;
  // Server-derived partial state: a planned run with no pinned Data Validation execution.
  const dataValidationMissing = Boolean(run && run.status === "planned" && !execution);

  const fingerprint = useMemo(() => manifestFingerprint(workspace.manifest), [workspace.manifest]);
  const storageKey = `helix.freeze-authorization.${studyId}.${fingerprint}`;
  const [consent, setConsent] = useState(false);
  const [authorizationId, setAuthorizationId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"freeze" | "retry" | null>(null);
  const [refusals, setRefusals] = useState<FreezeRefusal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<FreezeDataValidationFailure | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const liveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A durable authorization action survives a reload, so a retry after a timeout or
    // unknown result reuses the same idempotency key. A changed manifest has a new key.
    setAuthorizationId(window.localStorage.getItem(storageKey));
  }, [storageKey]);

  function toggleConsent(checked: boolean) {
    setConsent(checked);
    if (checked && !authorizationId) {
      const id = newAuthorizationId();
      window.localStorage.setItem(storageKey, id);
      setAuthorizationId(id);
    }
  }

  async function freeze() {
    if (!authorizationId) return;
    onKeepView?.();
    setBusy("freeze");
    setError(null);
    setRefusals([]);
    setPartial(null);
    setAnnouncement("");
    try {
      const result = await freezePinnedRun(studyId, {
        actor: ACTOR,
        idempotency_key: freezeIdempotencyKey(studyId, fingerprint, authorizationId),
      });
      await onRefresh();
      setAnnouncement(`Manifest frozen by the server as Pinned Run ${result.run_id}.`);
    } catch (cause) {
      if (cause instanceof FreezeError && cause.partial) {
        setPartial(cause.partial);
        await onRefresh();
        setAnnouncement(`Manifest frozen as ${cause.partial.run_id}; Data Validation failed. Retry Data Validation.`);
      } else if (cause instanceof FreezeError && cause.refusals.length > 0) {
        setRefusals(cause.refusals);
        setAnnouncement(`The server refused the freeze: ${cause.refusals.map((item) => item.message).join("; ")}.`);
        await onRefresh();
      } else {
        const message = cause instanceof Error ? cause.message : "The freeze command failed.";
        setError(message);
        setAnnouncement(`Freeze failed: ${message}`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function retryDataValidation() {
    if (!run) return;
    onKeepView?.();
    setBusy("retry");
    setError(null);
    try {
      await retryFreezeDataValidation(
        studyId,
        partial ?? {
          run_id: run.run_id,
          retry: {
            operation: "run_data_validation",
            method: "POST",
            path: `/api/v1/studies/${studyId}/data-validation-packages`,
            package_id: DATA_VALIDATION_PACKAGE_ID,
            idempotency_key: freezeDataValidationKey(run.run_id),
          },
        },
        ACTOR,
      );
      setPartial(null);
      await onRefresh();
      setAnnouncement(`Data Validation recorded for Pinned Run ${run.run_id}.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Data Validation retry failed.";
      setError(message);
      setAnnouncement(`Data Validation retry failed: ${message}`);
    } finally {
      setBusy(null);
    }
  }

  const authorized = workspace.manifest.filter((entry) => entry.authorized_by.trim().length > 0).length;
  const total = workspace.manifest.length;
  const tiersAssigned = workspace.manifest.every((entry) => entry.authority_tier >= 1);
  const checksums = workspace.manifest.every((entry) => entry.checksum.trim().length > 0);

  return (
    <div className="stack" data-testid="upload-gate" data-frozen={frozen ? "true" : "false"}>
      <GateBanner
        gateNumber={1}
        passed={passed}
        title="Upload and authorize study inputs"
        right="The agent cannot start until the study owner authorizes the inputs."
        data-testid="upload-gate-banner"
      />
      <div className="g-upload">
        <Card stack aria-labelledby="hx-up-h">
          <div>
            <h1 id="hx-up-h">Study inputs</h1>
            <p className="hx-sub">
              Protocol, template, source data and the approved report pattern. HELIX hashes and freezes each file.
            </p>
          </div>
          {!frozen && children}
          <DataTable<ManifestEntry>
            label="Study inputs"
            data-testid="manifest-table"
            rows={workspace.manifest}
            rowKey={(entry) => entry.artifact_id}
            columns={[
              {
                key: "file",
                header: "File",
                cell: (entry) => (
                  <span className="hx-cell-file" title={`${entry.artifact_id}@${entry.version} · ${entry.checksum}`}>
                    <FileIcon />
                    <span className="hx-ellipsis">{entry.name}</span>
                  </span>
                ),
              },
              { key: "type", header: "Type", cell: (entry) => fileType(entry.name), cellClassName: "hx-mono" },
              {
                key: "role",
                header: "Role",
                cell: (entry) => humanKind(entry.kind),
                cellClassName: "hx-cell-ink2",
              },
              {
                key: "status",
                header: "Status",
                cell: (entry) =>
                  frozen ? (
                    <Chip tone="pass" data-testid={`manifest-status-${entry.artifact_id}`}>
                      Frozen
                    </Chip>
                  ) : (
                    <Chip tone="muted" data-testid={`manifest-status-${entry.artifact_id}`}>
                      {entry.locked ? "Seeded" : "Uploaded"}
                    </Chip>
                  ),
              },
            ]}
          />
          <details data-testid="manifest-hashes">
            <summary>Checksums and versions</summary>
            <ul className="hx-up-list">
              {workspace.manifest.map((entry) => (
                <li key={entry.artifact_id}>
                  <span className="hx-mono">{entry.artifact_id}</span>@{entry.version} ·{" "}
                  <span className="hx-mono">{entry.checksum}</span> · authorized by {entry.authorized_by}
                </li>
              ))}
            </ul>
          </details>
        </Card>

        <Card as="aside" stack aria-labelledby="hx-auth-h" data-testid="authorization-card">
          <div>
            <Kicker>Authorization</Kicker>
            <h2 id="hx-auth-h" style={{ marginTop: 4 }}>
              Freeze the manifest
            </h2>
          </div>
          <div data-testid="authorization-checklist">
            <ListRow icon={<CheckIcon />} iconColor={toneColor(authorized === total ? "pass" : "warn")}>
              {`${authorized} of ${total} seeded inputs authorized`}
            </ListRow>
            <ListRow icon={<CheckIcon />} iconColor={toneColor(tiersAssigned ? "pass" : "warn")}>
              {tiersAssigned ? "Authority tiers assigned" : "Authority tiers missing"}
            </ListRow>
            <ListRow icon={<CheckIcon />} iconColor={toneColor(checksums ? "pass" : "warn")}>
              {checksums ? "Seeded checksums recorded" : "Checksums missing"}
            </ListRow>
            <ListRow icon={<WarnIcon />} iconColor={toneColor("warn")}>
              <span data-testid="unsupported-upload-validation">
                Server type and checksum validation of uploaded bytes before freeze is not available yet (#26 upload
                sessions). This gate freezes the seeded package.
              </span>
            </ListRow>
          </div>
          <label className="hx-consent">
            <input
              type="checkbox"
              data-testid="freeze-consent"
              checked={frozen || consent}
              disabled={frozen || busy !== null}
              onChange={(event) => toggleConsent(event.target.checked)}
            />
            <span>{`I authorize these ${total} inputs for ${studyId}. The agent may use only these frozen versions.`}</span>
          </label>
          <Button
            variant="primary"
            data-testid="freeze-manifest"
            disabled={frozen || !consent || !authorizationId || busy !== null}
            onClick={() => void freeze()}
          >
            {frozen && run
              ? `Manifest frozen \u00b7 ${run.run_id}`
              : busy === "freeze"
                ? "Freezing\u2026"
                : "Freeze authorized manifest"}
          </Button>
          <p className="hx-sub" style={{ margin: 0, fontSize: 12 }}>
            Freezing pins the checksums and runs the pinned body-weight Data Validation. The agent stops at the next
            human gate.
          </p>

          {(dataValidationMissing || partial) && run && (
            <div className="hx-notice t-block" role="alert" data-testid="freeze-partial">
              <span>Manifest frozen; Data Validation failed.</span>
              <Button size="sm" data-testid="retry-data-validation" disabled={busy !== null} onClick={() => void retryDataValidation()}>
                <RetryIcon size={14} />
                {busy === "retry" ? "Retrying\u2026" : "Retry Data Validation"}
              </Button>
            </div>
          )}
          {refusals.length > 0 && (
            <div className="hx-notice t-block" role="alert" data-testid="freeze-refused">
              <div>
                <strong>The server refused the freeze.</strong>
                <ul className="hx-up-list">
                  {refusals.map((item, index) => (
                    <li key={`${item.code}-${item.subject}-${index}`} data-code={item.code}>
                      <span className="hx-mono">{item.subject}</span>: {item.message} ({item.code})
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {error && (
            <div className="hx-notice t-block" role="alert" data-testid="freeze-error">
              <span>{error}</span>
            </div>
          )}
          <div className="hx-sr" aria-live="polite" aria-atomic="true" ref={liveRef} data-testid="freeze-live">
            {announcement}
          </div>
        </Card>
      </div>
      {run && <PinnedRunDetail run={run} execution={execution} />}
    </div>
  );
}

function fileType(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toUpperCase() : "FILE";
}

function humanKind(kind: string): string {
  const text = kind.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
