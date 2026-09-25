"use client";

import { INTAKE_JOB_STAGES, type IntakeJob } from "@/lib/api/intake";

import { Chip } from "../ui";

// Lane A (#26): stage-by-stage progress for `GET /api/v1/studies/jobs/{id}`.
// Counts of completed stages only; no percentage or ETA is invented.

export function IntakeJobProgress({ job }: { job: IntakeJob }) {
  const tone = job.status === "succeeded" ? "pass" : job.status === "failed" ? "block" : "warn";
  return (
    <div data-testid="intake-job-progress" data-status={job.status}>
      <p className="hx-sub" style={{ margin: 0 }}>
        <span className="hx-mono">{job.job_id}</span> for <span className="hx-mono">{job.study_id}</span>{" "}
        <Chip tone={tone} data-testid="intake-job-status">
          {job.status}
        </Chip>{" "}
        <span data-testid="intake-job-count">{`${job.stages_completed} of ${job.stages_total} stages`}</span>
      </p>
      <ol className="hx-up-list" aria-label="Upload job stages">
        {INTAKE_JOB_STAGES.map((stage) => {
          const done = Boolean(job.stages && stage in job.stages);
          const current = !done && job.stage === stage && job.status === "running";
          return (
            <li key={stage} data-testid={`intake-stage-${stage}`} data-state={done ? "done" : current ? "current" : "pending"} aria-current={current ? "step" : undefined}>
              {stage}: {done ? "done" : current ? "running" : job.status === "failed" && job.stage === stage ? "failed" : "pending"}
            </li>
          );
        })}
      </ol>
      {job.error && (
        <div className="hx-notice t-block" role="alert" data-testid="intake-job-error">
          <span>{job.error}</span>
        </div>
      )}
    </div>
  );
}
