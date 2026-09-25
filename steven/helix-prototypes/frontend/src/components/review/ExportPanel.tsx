"use client";

import { artifactLabel } from "@/lib/api/release";
import type { ExportReceipt, Workspace } from "@/lib/types";

import { RetryIcon } from "../icons";
import { Button, Spinner } from "../ui";
import { DEMO_EXPORT_REASON, DEMO_NOT_AVAILABLE, exportedAtFromJourney, isDemoFrozen } from "./reviewState";

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
  // DH-7 (#68): the server refuses every export of a demo-frozen run (409 demo_not_qualified),
  // so the button stays disabled with the reason instead of inviting a refused click or retry.
  // DH-8 (#79): this also covers a demo run exported before the DH-7 guard. Its files and hashes
  // now return 409, so the panel shows a refused state instead of a live receipt.
  const demoFrozen = isDemoFrozen(workspace);
  const ready = status === "ready_for_export" && !demoFrozen;
  const exportedAt = state.kind === "success" ? state.receipt.exported_at : exportedAtFromJourney(workspace);
  // DH-6 (#71): the receipt names exactly what left HELIX: the slice-11 approved files and their
  // full hashes, from the export response or, after reload, the workspace export_artifacts.
  const files =
    state.kind === "success"
      ? state.receipt.artifacts
      : workspace.export_artifacts.filter((item) => item.status === "exported");
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
        ) : exported && demoFrozen ? (
          "Export not available"
        ) : exported ? (
          "Package exported"
        ) : state.kind === "error" && !demoFrozen ? (
          <>
            <RetryIcon size={16} /> Retry export
          </>
        ) : (
          "Export final package"
        )}
      </Button>
      {demoFrozen ? (
        <p className="hx-sub hx-fine" data-testid="export-disabled-reason" data-gate="demo_not_qualified">
          {DEMO_EXPORT_REASON}
        </p>
      ) : (
        !ready &&
        !exported && (
          <p className="hx-sub hx-fine" data-testid="export-disabled-reason" data-gate={status}>
            {disabledReason(status)}
          </p>
        )
      )}
      {state.kind === "error" && (
        <p className="hx-notice t-block" role="alert" data-testid="export-error">
          Export failed: {state.message} Nothing was exported.
        </p>
      )}
      {demoFrozen && exported && (
        <p className="hx-notice t-warn" data-testid="export-receipt-refused">
          {DEMO_NOT_AVAILABLE}. An earlier export of this run is refused by the server, so its files and hashes
          are not shown or served.
        </p>
      )}
      {!demoFrozen && (state.kind === "success" || exported) && (
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
          <dt>What was exported</dt>
          <dd data-testid="export-receipt-scope">
            Only the {files.length} {files.length === 1 ? "file" : "files"} approved in Final Study Approval, with
            these SHA-256 hashes:
            <ul className="hx-export-hashes" data-testid="export-receipt-hashes">
              {files.map((item) => (
                <li key={item.artifact_id}>
                  <span>{artifactLabel(item.kind)}</span>{" "}
                  <code className="hx-mono" data-testid={`export-receipt-hash-${item.artifact_id}`}>
                    {item.checksum}
                  </code>
                </li>
              ))}
            </ul>
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
