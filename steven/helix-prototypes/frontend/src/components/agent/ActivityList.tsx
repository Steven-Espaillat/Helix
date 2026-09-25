import type { JourneyAction, JourneyStage } from "@/lib/types";

import { CheckIcon, WarnIcon } from "../icons";
import { Card, Spinner } from "../ui";

// Lane B (#21). "Agent activity" card from the reference (section 5.5). Rows come from the
// server projection (stage.actions, fed by #25's run events): queued -> done, with blockers
// flagged. The only client-side row is the HTTP request in flight right now; it says
// "Request in progress" and never marks anything recorded.

const STATUS_TEXT: Record<JourneyAction["status"], string> = {
  done: "Recorded",
  blocked: "Blocked",
  pending: "Queued",
};

function flag(action: JourneyAction): string | null {
  if (action.outcome === "blocker" || action.status === "blocked") return "Blocker";
  if (action.outcome === "warning") return "Warning";
  if (action.outcome === "dispositioned") return "Disposition";
  return null;
}

export function ActivityList({ stage, inFlightLabel }: { stage: JourneyStage; inFlightLabel: string | null }) {
  const done = stage.actions.filter((action) => action.status !== "pending").length;
  const total = stage.actions.length + (inFlightLabel ? 1 : 0);
  return (
    <Card aria-labelledby="agent-activity-heading" data-testid="agent-activity-card">
      <div className="hx-agent-activity-head">
        <h3 id="agent-activity-heading">Agent activity</h3>
        <span className="hx-sub" data-testid="agent-activity-count">
          {done} of {total} actions
        </span>
      </div>
      <ol className="hx-agent-acts" aria-live="polite" data-testid="agent-activity">
        {stage.actions.map((action) => {
          const tag = flag(action);
          const recorded = action.status !== "pending";
          return (
            <li
              key={action.action_id}
              className={recorded ? "hx-act" : "hx-act queued"}
              data-testid="agent-action"
              data-status={action.status}
            >
              <span className="ic" aria-hidden="true">
                {recorded && tag === "Blocker" ? (
                  <span className="hx-agent-ic block">
                    <WarnIcon />
                  </span>
                ) : recorded ? (
                  <span className="hx-agent-ic pass">
                    <CheckIcon />
                  </span>
                ) : (
                  <span className="hx-hollow" />
                )}
              </span>
              <span className="txt">
                {action.label}
                {action.detail && <span className="hx-sub hx-agent-detail"> · {action.detail}</span>}
                <span className="hx-sr"> · {STATUS_TEXT[action.status]}</span>
              </span>
              {recorded && tag && <span className={`tag hx-agent-tag ${tag === "Blocker" ? "block" : "warn"}`}>{tag}</span>}
            </li>
          );
        })}
        {inFlightLabel && (
          <li className="hx-act active" data-testid="agent-request-in-flight">
            <span className="ic" aria-hidden="true">
              <Spinner />
            </span>
            <span className="txt">{inFlightLabel}</span>
            <span className="tag hx-agent-tag accent">Request in progress</span>
          </li>
        )}
      </ol>
      {stage.actions.length === 0 && !inFlightLabel && (
        <p className="hx-sub" data-testid="agent-activity-empty">
          No recorded activity for this stage yet.
        </p>
      )}
    </Card>
  );
}
