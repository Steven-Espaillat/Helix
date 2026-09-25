import type { WorkbenchJourney } from "@/lib/types";

import { Banner, Button, Spinner, StatusDot } from "../ui";
import { AGENT_STAGE_IDS } from "./stages";

// Lane B (#21). Run banner from research/helix-e2e-workbench-v1.html (section 5.5), driven by
// the server journey: the stage the SERVER reports as current, plus whether this page has a
// governed HTTP request in flight. Pause and Resume stay disabled until #26 adds commands.

const NEXT_GATE = "Traceability review";

function PauseControl({ paused }: { paused: boolean }) {
  return (
    <>
      <Button
        size="sm"
        variant={paused ? "primary" : undefined}
        disabled
        aria-describedby="agent-pause-note"
        data-testid="agent-pause"
      >
        {paused ? "Resume agent" : "Pause"}
      </Button>
      <span id="agent-pause-note" className="hx-sr">
        Pause and resume are unavailable: the server has no pause or resume command yet.
      </span>
    </>
  );
}

export function RunBanner({ journey, inFlightLabel }: { journey: WorkbenchJourney; inFlightLabel: string | null }) {
  const agentStages = journey.stages.filter((stage) => (AGENT_STAGE_IDS as readonly string[]).includes(stage.stage_id));
  const current = agentStages.find((stage) => stage.status !== "complete");
  const total = journey.stages.length;

  if (!current) {
    const gate = journey.stages.find((stage) => stage.kind === "human_gate" && stage.status !== "complete");
    return (
      <Banner
        tone="passed"
        data-testid="agent-run-banner"
        leading={<StatusDot color="var(--hx-pass)" />}
        kicker="Agent run complete"
        title={`Stages 2–7 finished.${gate ? ` Waiting at human gate: ${gate.name}` : ""}`}
      />
    );
  }
  if (inFlightLabel) {
    return (
      <Banner
        tone="running"
        data-testid="agent-run-banner"
        leading={<Spinner />}
        kicker={`Agent working · Stage ${current.sequence} of ${total}`}
        title={`${current.name} — ${inFlightLabel}`}
        right={
          <>
            Next human gate: {NEXT_GATE}
            <PauseControl paused={false} />
          </>
        }
      />
    );
  }
  const paused = current.status === "paused";
  const blocked = current.status === "blocked";
  return (
    <Banner
      tone="paused"
      data-testid="agent-run-banner"
      leading={<StatusDot color={blocked ? "var(--hx-block)" : "var(--hx-muted)"} />}
      kicker={`${paused ? "Agent paused" : blocked ? "Agent blocked" : "Agent waiting"} · Stage ${current.sequence} of ${total}`}
      title={current.name}
      right={
        <>
          Next human gate: {NEXT_GATE}
          <PauseControl paused={paused} />
        </>
      }
    />
  );
}
