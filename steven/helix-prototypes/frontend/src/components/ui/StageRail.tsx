import type { ReactNode } from "react";

import { CheckIcon, PersonIcon } from "../icons";
import { Kicker, Spinner, cx } from "./primitives";

// Presentational Progress Bar (stage rail) from research/helix-e2e-workbench-v1.html
// (HANDOFF section 5.2). OWNER: step 0 (visuals). Lane A (#19) owns mapping
// the backend journey projection onto `StageRailNode[]`: this component never
// derives progress, never merges stages, and renders exactly what it is given.

export type StageRailNode = {
  key: string;
  shortLabel: string;
  name: string;
  kind: "gate" | "agent";
  state: "done" | "current" | "pending";
  /** Agent stage with an active server run: shows the spinner on the node. */
  running?: boolean;
  /** Server-facing status text: Done, Approved, Agent running, Paused, Awaiting you, Agent, Human gate. */
  statusLabel: string;
  /** Future stages are disabled from server eligibility. */
  disabled: boolean;
};

export type StageRailProps = {
  stages: StageRailNode[];
  selectedKey?: string;
  onSelect?: (key: string) => void;
  /** Overrides the "N of M stages complete" summary. */
  summary?: ReactNode;
  hint?: ReactNode;
  "data-testid"?: string;
};

export function StageRail({
  stages,
  selectedKey,
  onSelect,
  summary,
  hint = "Select a completed stage to review it",
  ...rest
}: StageRailProps) {
  const done = stages.filter((stage) => stage.state === "done").length;
  const pct = stages.length ? Math.round((done / stages.length) * 100) : 0;
  return (
    // The accessible name is fixed: tests/shell.spec.ts requires exactly one
    // navigation named "Journey progress" (shell contract), so it is not a prop.
    <nav className="hx-stepper" aria-label="Journey progress" data-testid={rest["data-testid"]}>
      <div className="hx-stepper-head">
        <div className="hx-progress">
          <Kicker>Journey progress</Kicker>
          {summary ?? (
            <>
              {/* One text node, as in the reference (split nodes shape differently). */}
              <strong>{`${done} of ${stages.length} stages complete`}</strong>
              <span className="hx-sub">{`\u00b7 ${pct}%`}</span>
            </>
          )}
        </div>
        <div className="hx-legend">
          <span>
            <i className="gate" />
            Human gate
          </span>
          <span>
            <i className="agent" />
            Agent step
          </span>
          {hint && <span>{hint}</span>}
        </div>
      </div>
      <ol className="hx-steps">
        {stages.map((stage, index) => {
          const gate = stage.kind === "gate";
          const isDone = stage.state === "done";
          const isCurrent = stage.state === "current";
          const statusClass = isDone ? "s-done" : gate ? "s-gate" : isCurrent ? "s-current" : "s-pending";
          const left = index === 0 ? "none" : isDone || isCurrent ? "done" : "";
          const right = index === stages.length - 1 ? "none" : isDone ? "done" : "";
          const node = isDone ? (
            <CheckIcon size={14} strokeWidth={3} />
          ) : isCurrent && !gate && stage.running ? (
            <Spinner onFill />
          ) : gate ? (
            <PersonIcon size={15} strokeWidth={2.2} />
          ) : (
            index + 1
          );
          return (
            <li key={stage.key}>
              <button
                type="button"
                className={cx("hx-step", selectedKey === stage.key && "is-selected", isCurrent && "is-current")}
                disabled={stage.disabled}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={`Stage ${index + 1}: ${stage.name} (${stage.statusLabel})`}
                onClick={() => onSelect?.(stage.key)}
              >
                <span className="hx-step-track">
                  <span className={cx("hx-step-line", left)} />
                  <span className={cx("hx-node", gate && "gate", isDone ? "done" : isCurrent && "current")}>{node}</span>
                  <span className={cx("hx-step-line", right)} />
                </span>
                <span className="hx-step-label">{stage.shortLabel}</span>
                <span className={cx("hx-step-status", statusClass)}>{stage.statusLabel}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
