"use client";

import type { Workspace } from "@/lib/types";

import { Card, Chip, Kicker } from "../ui";

type PinnedRun = NonNullable<Workspace["pinned_run"]>;
type Execution = Workspace["data_validation_executions"][number];

// Lane A (#20): server Pinned Run identity after the freeze. Everything here is read
// from `WorkspaceResponse.pinned_run` and its Data Validation execution.

export function PinnedRunDetail({ run, execution }: { run: PinnedRun; execution: Execution | null }) {
  const resolution = run.study_type_resolution;
  return (
    <Card stack aria-labelledby="hx-pinned-run-h" data-testid="pinned-run-detail">
      <div>
        <Kicker>Pinned Run</Kicker>
        <h2 id="hx-pinned-run-h" style={{ marginTop: 4 }}>
          <span className="hx-mono" data-testid="pinned-run-id">
            {run.run_id}
          </span>{" "}
          <Chip tone={run.status === "planned" ? "pass" : "warn"} data-testid="pinned-run-status">
            {run.status.replaceAll("_", " ")}
          </Chip>
        </h2>
      </div>
      <dl className="hx-up-kv" data-testid="pinned-run-identity">
        <dt>Manifest hash</dt>
        <dd className="hx-mono" data-testid="pinned-run-manifest-hash">{run.manifest_hash}</dd>
        <dt>Run receipt</dt>
        <dd className="hx-mono" data-testid="pinned-run-receipt">{run.receipt.receipt_id}</dd>
        <dt>Governed inputs fingerprint</dt>
        <dd className="hx-mono">{run.receipt.governed_inputs_fingerprint}</dd>
        <dt>Run plan</dt>
        <dd className="hx-mono" data-testid="pinned-run-plan">
          {run.run_plan.run_plan_id} · v{run.run_plan.version}
        </dd>
        <dt>Run-plan fingerprint</dt>
        <dd className="hx-mono">{run.run_plan.fingerprint}</dd>
        <dt>Created</dt>
        <dd>{run.created_at}</dd>
      </dl>

      <details data-testid="pinned-run-nodes">
        <summary>{`Run-plan nodes (${run.run_plan.nodes.length})`}</summary>
        <ul className="hx-up-list">
          {run.run_plan.nodes.map((node) => (
            <li key={node.node_id}>
              <span className="hx-mono">{node.node_id}</span> · {node.node_type.replaceAll("_", " ")}
              {node.package_id ? ` · ${node.package_id}@${node.package_version ?? "?"}` : ""} · {node.status}
            </li>
          ))}
        </ul>
      </details>

      <details data-testid="pinned-run-governed-inputs">
        <summary>{`Governed inputs (${run.governed_inputs.length})`}</summary>
        <ul className="hx-up-list">
          {run.governed_inputs.map((input) => (
            <li key={`${input.kind}:${input.artifact_id}`}>
              <span className="hx-mono">{input.artifact_id}</span>@{input.version} · {input.kind} ·{" "}
              <span className="hx-mono">{input.content_hash}</span>
            </li>
          ))}
        </ul>
      </details>

      <details data-testid="pinned-run-resolution">
        <summary>
          {`Study type resolution: ${resolution.study_type_id ?? "unresolved"} (${resolution.status.replaceAll("_", " ")})`}
        </summary>
        <dl className="hx-up-kv">
          <dt>Mapping</dt>
          <dd className="hx-mono">
            {resolution.mapping_version} · {resolution.mapping_hash}
          </dd>
          {Object.entries(resolution.protocol_fields).map(([key, value]) => (
            <FieldRow key={key} name={key} value={String(value)} />
          ))}
        </dl>
        {resolution.evidence.length > 0 && (
          <ul className="hx-up-list">
            {resolution.evidence.map((item, index) => (
              <li key={`${item.code}-${index}`}>
                {item.code}: {item.message}
              </li>
            ))}
          </ul>
        )}
      </details>

      <div data-testid="pinned-run-data-validation">
        <Kicker size="sm">Data Validation</Kicker>
        {execution ? (
          <p className="hx-sub" style={{ margin: "4px 0 0" }}>
            <span className="hx-mono">{execution.receipt.receipt_id}</span> · {execution.receipt.package_id} ·{" "}
            {execution.receipt.status} · {execution.claims.length} claims
          </p>
        ) : (
          <p className="hx-sub" style={{ margin: "4px 0 0" }} data-testid="pinned-run-data-validation-missing">
            No Data Validation execution is recorded for this run.
          </p>
        )}
      </div>
    </Card>
  );
}

function FieldRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt>{name.replaceAll("_", " ")}</dt>
      <dd>{value}</dd>
    </>
  );
}
