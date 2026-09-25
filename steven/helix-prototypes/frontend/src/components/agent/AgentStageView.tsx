"use client";

import { isAgentStep } from "@/lib/api/agentSteps";
import type { JourneyStage, Workspace } from "@/lib/types";

import { PersonIcon, ShieldIcon } from "../icons";
import { Button, Card, Chip, Kicker, type Tone } from "../ui";
import { ActivityList } from "./ActivityList";
import { RunBanner } from "./RunBanner";
import { StageEvidence } from "./StageEvidence";
import { StageIO } from "./StageIO";
import { isAgentStageId, type AgentStageId } from "./stages";
import { useAgentSteps } from "./useAgentSteps";

export { AGENT_STAGE_IDS, isAgentStageId } from "./stages";

// Lane B (#21). One Agent Step view for stages 2-7 (Parse through Provenance), laid out as
// research/helix-e2e-workbench-v1.html section 5.5: run banner, then a left stage card
// (summary, Input -> Output, control boundary) and a right "Agent activity" card.
// Everything comes from the server Workspace and its journey projection. Commands appear
// only on the stage the server reports as current or blocked; a completed stage is
// read-only review, and selecting it never changes progress.

type Props = {
  studyId: string;
  workspace: Workspace;
  stageId: AgentStageId;
  onWorkspace: (workspace: Workspace) => void;
  /** Another workbench command is running; governed commands here wait. */
  otherBusy?: boolean;
  /** Tells the workbench an agent command is in flight, so legacy controls wait. */
  onBusyChange?: (busy: boolean) => void;
};

const CHIP: Record<JourneyStage["status"], [string, Tone]> = {
  complete: ["Completed", "pass"],
  current: ["Current", "accent"],
  blocked: ["Blocked", "block"],
  paused: ["Paused", "muted"],
  pending: ["Not started", "muted"],
};

export function AgentStageView({ studyId, workspace, stageId, onWorkspace, otherBusy = false, onBusyChange }: Props) {
  const agent = useAgentSteps({ studyId, workspace, onWorkspace, onBusyChange });
  const stage = workspace.journey.stages.find((item) => item.stage_id === stageId);
  if (!stage || !isAgentStageId(stage.stage_id)) return null;

  const { next, inFlight } = agent;
  const actionable = stage.status === "current" || stage.status === "blocked";
  const busy = Boolean(inFlight) || otherBusy;
  const llm = workspace.planner_capabilities.find((item) => item.mode === "openai_compatible");
  const [chipText, chipTone] = inFlight?.stageId === stage.stage_id ? (["Running", "accent"] as const) : CHIP[stage.status];

  return (
    <div className="stack hx-agent-view" data-testid="agent-stage-view" data-stage={stage.stage_id}>
      <RunBanner journey={workspace.journey} inFlightLabel={inFlight?.label ?? null} />
      <div className="g-agent">
        <Card stack aria-labelledby="agent-stage-heading" data-testid="agent-stage-card">
          <div className="hx-agent-title-row">
            <div>
              <Kicker>
                Stage {stage.sequence} of {workspace.journey.stages.length} · Agent step
              </Kicker>
              <h1 id="agent-stage-heading" className="hx-agent-h">
                {stage.name}
              </h1>
            </div>
            <Chip tone={chipTone} size="lg" data-testid="agent-stage-chip">
              {chipText}
            </Chip>
          </div>
          <p className="hx-agent-summary" data-testid="agent-stage-summary">
            {stage.summary}
          </p>
          <StageIO stage={stage} />
          <div className="hx-boundary" data-testid="agent-control-boundary">
            <span className="hx-agent-shield">
              <ShieldIcon size={18} />
            </span>
            <div>
              <strong>Control boundary. </strong>
              {stage.control_boundary}
            </div>
          </div>

          <div
            className={agent.message ? `hx-agent-live ${agent.message.tone === "block" ? "t-block" : "t-info"}` : "hx-agent-live"}
            role="status"
            aria-live="polite"
            data-testid="agent-live"
            data-tone={agent.message?.tone}
          >
            {agent.message && (
              <>
                <span>{agent.message.text}</span>
                <Button size="sm" aria-label="Dismiss agent message" onClick={agent.dismissMessage}>
                  Close
                </Button>
              </>
            )}
          </div>

          {actionable && (
            <div className="hx-agent-commands" data-testid="agent-commands">
              {stage.stage_id === "validate" && (
                <fieldset className="hx-agent-planner">
                  <legend>Planner</legend>
                  <label>
                    <input
                      type="radio"
                      name="agent-planner"
                      checked={agent.planner === "fixture"}
                      onChange={() => agent.setPlanner("fixture")}
                    />{" "}
                    Fixture planner (no LLM)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="agent-planner"
                      checked={agent.planner === "openai_compatible"}
                      disabled={!llm?.available}
                      onChange={() => agent.setPlanner("openai_compatible")}
                    />{" "}
                    LLM planner {llm?.available ? "" : "(not configured)"}
                  </label>
                </fieldset>
              )}
              {isAgentStep(next) ? (
                <>
                  <Button
                    variant="primary"
                    disabled={busy || (next.stageId !== stage.stage_id && !next.replay)}
                    onClick={agent.runStep}
                    data-testid="agent-run-step"
                  >
                    {inFlight ? `${inFlight.label}…` : next.label}
                  </Button>
                  <Button disabled={busy} onClick={agent.runSequence} data-testid="agent-run-sequence">
                    Run agent steps to the next stop
                  </Button>
                  {next.replay && (
                    <p className="hx-sub" data-testid="agent-replay-note">
                      Extract: the freeze already recorded the Data Validation execution. This call sends the same
                      run-scoped key, so the server returns that execution as an idempotent replay and never runs the
                      package twice.
                    </p>
                  )}
                  {next.stageId !== stage.stage_id && !next.replay && (
                    <p className="hx-sub" data-testid="agent-next-elsewhere">
                      The next governed command belongs to another stage: {next.label}.
                    </p>
                  )}
                </>
              ) : (
                <p className="hx-stage-note" data-testid="agent-stop" data-stop={next.kind}>
                  {next.kind === "gate" ? <PersonIcon size={16} /> : null} {next.message}
                </p>
              )}
            </div>
          )}
          {!actionable && stage.status === "complete" && (
            <p className="hx-sub" data-testid="agent-stage-review">
              Completed stage. Showing its recorded actions; nothing here changes progress.
            </p>
          )}

          <StageEvidence
            stageId={stage.stage_id}
            workspace={workspace}
            receipts={agent.receipts}
            eligibilityChange={agent.eligibilityChange}
          />
        </Card>
        <ActivityList stage={stage} inFlightLabel={inFlight?.stageId === stage.stage_id ? inFlight.label : null} />
      </div>
    </div>
  );
}
