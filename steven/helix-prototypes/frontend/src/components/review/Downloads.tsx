"use client";

import { useEffect, useState } from "react";

import { artifactDownloadUrl } from "@/lib/api";
import { artifactLabel, probeArtifact, type ArtifactProbe, type ExportArtifact } from "@/lib/api/release";
import type { Workspace } from "@/lib/types";

import { Card, DataTable, Kicker } from "../ui";
import { DEMO_EXPORT_REASON, DEMO_NOT_AVAILABLE, isDemoFrozen } from "./reviewState";

// Lane D (#23): after export, every artifact's ID, label, checksum, media type, and a download
// that uses artifactDownloadUrl and returns the server bytes. Media type comes from the download
// response's Content-Type. State comes from WorkspaceResponse.export_artifacts, so it survives reload.

export function Downloads({ workspace }: { workspace: Workspace }) {
  const studyId = workspace.study.study_id;
  // DH-8 (#79): a demo-frozen run's stored files return 409, so never link, hash or probe them.
  const demoFrozen = isDemoFrozen(workspace);
  const exported = demoFrozen ? [] : workspace.export_artifacts.filter((item) => item.status === "exported");
  const refusedCount = demoFrozen
    ? workspace.export_artifacts.filter((item) => item.status === "exported").length
    : 0;
  const [probes, setProbes] = useState<Record<string, ArtifactProbe | "error">>({});
  const key = exported.map((item) => `${item.artifact_id}:${item.checksum}`).join("|");

  useEffect(() => {
    let cancelled = false;
    const ids = key ? key.split("|").map((part) => part.split(":")[0]) : [];
    for (const artifactId of ids) {
      probeArtifact(artifactDownloadUrl(studyId, artifactId))
        .then((probe) => {
          if (!cancelled) setProbes((prior) => ({ ...prior, [artifactId]: probe }));
        })
        .catch(() => {
          if (!cancelled) setProbes((prior) => ({ ...prior, [artifactId]: "error" }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [key, studyId]);

  if (refusedCount > 0) {
    return (
      <Card className="stack" aria-labelledby="hx-dl-h" data-testid="downloads-refused">
        <div>
          <Kicker>Exported package</Kicker>
          <h2 id="hx-dl-h" className="hx-so-title">
            Downloads · {DEMO_NOT_AVAILABLE}
          </h2>
        </div>
        <p className="hx-sub hx-fine" data-testid="downloads-refused-reason">
          {DEMO_EXPORT_REASON} The {refusedCount} {refusedCount === 1 ? "file" : "files"} exported before this rule
          are not served.
        </p>
      </Card>
    );
  }
  if (exported.length === 0) return null;
  return (
    <Card className="stack" aria-labelledby="hx-dl-h" data-testid="downloads">
      <div>
        <Kicker>Exported package</Kicker>
        <h2 id="hx-dl-h" className="hx-so-title">
          Downloads · {exported.length} checksummed artifacts
        </h2>
      </div>
      <DataTable<ExportArtifact>
        label="Exported artifacts"
        template="minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.6fr) 150px 120px"
        rows={exported}
        rowKey={(row) => row.artifact_id}
        data-testid="downloads-table"
        columns={[
          { key: "id", header: "Artifact ID", cell: (row) => <span className="hx-mono">{row.artifact_id}</span> },
          { key: "label", header: "Label", cell: (row) => artifactLabel(row.kind) },
          {
            key: "checksum",
            header: "Checksum",
            cell: (row) => (
              <span className="hx-mono" data-testid={`download-checksum-${row.artifact_id}`}>
                {row.checksum}
              </span>
            ),
          },
          {
            key: "media",
            header: "Media type",
            cell: (row) => {
              const probe = probes[row.artifact_id];
              return (
                <span className="hx-mono" data-testid={`download-media-${row.artifact_id}`}>
                  {probe === undefined ? "checking…" : probe === "error" ? "unavailable" : (probe.mediaType ?? "unknown")}
                </span>
              );
            },
          },
          {
            key: "download",
            header: "Download",
            cell: (row) => (
              <a
                className="hx-btn sm"
                href={artifactDownloadUrl(studyId, row.artifact_id)}
                download
                data-testid={`download-${row.artifact_id}`}
              >
                Download
              </a>
            ),
          },
        ]}
      />
    </Card>
  );
}
