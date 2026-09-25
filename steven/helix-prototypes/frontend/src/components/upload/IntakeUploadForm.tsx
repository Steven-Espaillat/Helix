"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { getIntakeJob, submitIntakeJob, type IntakeJob } from "@/lib/api/intake";

import { UploadIcon } from "../icons";
import { Button, Kicker } from "../ui";
import { useStudySelection } from "../shell/StudyContext";
import { IntakeJobProgress } from "./IntakeJobProgress";
import { StudyPicker } from "./StudyPicker";

// Lane A (#26): real file upload through the existing background intake job
// (`POST /api/v1/studies/jobs`). Route and protocol version are governed facts the
// caller supplies; nothing is inferred. On success the new study is selected.
// Upload sessions with per-file server validation and pause/resume are escalated
// (they need shared routes and tables) and are not claimed here.

const POLL_MS = 1000;
const JOB_KEY = "helix.intake-job";

export function IntakeUploadForm() {
  const { selectStudy } = useStudySelection();
  const [files, setFiles] = useState<File[]>([]);
  const [studyId, setStudyId] = useState("");
  const [route, setRoute] = useState("");
  const [protocolVersion, setProtocolVersion] = useState("");
  const [authorizedBy, setAuthorizedBy] = useState("");
  const [job, setJob] = useState<IntakeJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const selectedFor = useRef<string | null>(null);

  // Resume polling a job that was in flight before a reload.
  useEffect(() => {
    const saved = window.localStorage.getItem(JOB_KEY);
    if (saved) void getIntakeJob(saved).then(setJob).catch(() => window.localStorage.removeItem(JOB_KEY));
  }, []);

  useEffect(() => {
    if (!job) return;
    if (job.status === "succeeded") {
      window.localStorage.removeItem(JOB_KEY);
      if (selectedFor.current !== job.job_id) {
        selectedFor.current = job.job_id;
        setRefreshKey((value) => value + 1);
        selectStudy(job.study_id);
      }
      return;
    }
    if (job.status === "failed") {
      window.localStorage.removeItem(JOB_KEY);
      return;
    }
    const timer = window.setTimeout(() => {
      getIntakeJob(job.job_id)
        .then(setJob)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Lost the upload job."));
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [job, selectStudy]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await submitIntakeJob({
        studyId: studyId.trim(),
        route: route.trim(),
        protocolVersion: protocolVersion.trim(),
        authorizedBy: authorizedBy.trim(),
        idempotencyKey: `intake-${studyId.trim()}-${files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|")}`.slice(0, 160),
        files,
      });
      window.localStorage.setItem(JOB_KEY, next.job_id);
      setJob(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The upload was not accepted.");
    } finally {
      setBusy(false);
    }
  }

  const running = job !== null && (job.status === "queued" || job.status === "running");
  const ready = files.length > 0 && /^STUDY-[A-Z0-9-]+$/.test(studyId.trim()) && route.trim().length >= 2 && protocolVersion.trim().length > 0 && authorizedBy.trim().length >= 2;

  return (
    <section className="stack" aria-labelledby="hx-intake-h" data-testid="intake-upload">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <Kicker size="sm">
          <span id="hx-intake-h">Upload a new study</span>
        </Kicker>
        <StudyPicker refreshKey={refreshKey} />
      </div>
      <form className="stack" onSubmit={(event) => void submit(event)} data-testid="intake-form">
        <label className="hx-drop">
          <UploadIcon />
          <span>{files.length ? `${files.length} file(s) chosen; not yet received by HELIX` : "Choose source files (CSV, XPT, XLSX, ZIP)"}</span>
          <input type="file" multiple data-testid="intake-files" disabled={running} onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
        </label>
        <div className="hx-up-fields">
          <label>
            Study ID
            <input data-testid="intake-study-id" value={studyId} placeholder="STUDY-..." onChange={(event) => setStudyId(event.target.value.toUpperCase())} disabled={running} />
          </label>
          <label>
            Route of administration
            <input data-testid="intake-route" value={route} onChange={(event) => setRoute(event.target.value)} disabled={running} />
          </label>
          <label>
            Protocol version
            <input data-testid="intake-protocol-version" value={protocolVersion} onChange={(event) => setProtocolVersion(event.target.value)} disabled={running} />
          </label>
          <label>
            Authorized by
            <input data-testid="intake-authorized-by" value={authorizedBy} onChange={(event) => setAuthorizedBy(event.target.value)} disabled={running} />
          </label>
        </div>
        <Button type="submit" data-testid="intake-submit" disabled={!ready || busy || running}>
          {busy ? "Uploading\u2026" : "Upload and process"}
        </Button>
      </form>
      {error && (
        <div className="hx-notice t-block" role="alert" data-testid="intake-error">
          <span>{error}</span>
        </div>
      )}
      {job && <IntakeJobProgress job={job} />}
      <p className="hx-sub" style={{ margin: 0, fontSize: 12 }} data-testid="intake-gaps">
        Resumable upload sessions, per-file server validation before freeze, and pause/resume are not available yet.
      </p>
    </section>
  );
}
