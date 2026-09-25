"use client";

import type { ExportReceipt, Workspace } from "@/lib/types";

import { RetryIcon } from "../icons";
import { Button, Spinner } from "../ui";
import { exportedAtFromJourney } from "./reviewState";

// Lane D (#23): the explicit export. Enabled only when the SERVER release gate reports
// ready_for_export. It is its own button press with loading, success, error, and replay states.

export type ExportState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; receipt: ExportReceipt }
  | { kind: "error"; message: string };

export function ExportPanel({
  workspace,
  state,
  onExport,
}: {
  workspace: Workspace;
  state: ExportState;
  onExport: () => void;
}) {
  const status = workspace.release_gate.status;
  const exported = status === "exported";
  const ready = status === "ready_for_export";
  const exportedAt = state.kind === "success" ? state.receipt.exported_at : exportedAtFromJourney(workspace);
  return (
    <div className="stack hx-export" data-testid="export-panel" data-state={state.kind}>
      <Button
        variant="primary"
        disabled={!ready || state.kind === "loading"}
        onClick={onExport}
        data-testid="export-final-package"
      >
        {state.kind === "loading" ? (
          <>
            <Spinner onFill /> Exporting…
          </>
        ) : exported ? (
          "Package exported"
        ) : state.kind === "error" ? (
          <>
            <RetryIcon size={16} /> Retry export
          </>
        ) : (
          "Export final package"
        )}
      </Button>
      {!ready && !exported && (
        <p className="hx-sub hx-fine" data-testid="export-disabled-reason" data-gate={status}>
          {disabledReason(status)}
        </p>
      )}
      {state.kind === "error" && (
        <p className="hx-notice t-block" role="alert" data-testid="export-error">
          Export failed: {state.message} Nothing was exported.
        </p>
      )}
      {(state.kind === "success" || exported) && (
        <dl className="hx-export-receipt" data-testid="export-receipt">
          <dt>Exported</dt>
          <dd>
            {exportedAt ? (
              <time dateTime={exportedAt} data-testid="export-exported-at">
                {localTime(exportedAt)}
              </time>
            ) : (
              <span data-testid="export-exported-at">Recorded by the server</span>
            )}
          </dd>
          {state.kind === "success" && state.receipt.idempotent_replay && (
            <>
              <dt>Repeat export</dt>
              <dd data-testid="export-idempotent-replay">Already exported. The server returned the same package.</dd>
            </>
          )}
        </dl>
      )}
      <p className="hx-sub hx-fine">
        Export is a separate action after approval. A prepared package is not FDA acceptance.
      </p>
    </div>
  );
}

/** Plain-language reason for a disabled export, from the server release gate status. */
function disabledReason(status: string): string {
  switch (status) {
    case "ready_for_signature":
      return "Export unlocks after Final Study Approval is signed.";
    case "ready_for_review":
    case "blocked":
      return "Export unlocks after every sign-off above is recorded.";
    default:
      return "Export is not available yet.";
  }
}

/** The export time in the reader's local time zone; the full timestamp stays in dateTime. */
function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
