import type { JourneyStage } from "@/lib/types";

import { ArrowIcon } from "../icons";
import { Kicker } from "../ui";

// Lane B (#21). Input -> Output boxes for an Agent Step, straight from the server projection.
export function StageIO({ stage }: { stage: JourneyStage }) {
  return (
    <div className="hx-io" data-testid="agent-stage-io">
      <div>
        <Kicker size="sm">Input</Kicker>
        <div className="hx-agent-io-title">{stage.input.title}</div>
        <div className="hx-mono">{stage.input.detail}</div>
      </div>
      <div className="arrow" aria-hidden="true">
        <ArrowIcon size={18} />
      </div>
      <div className="out">
        <Kicker size="sm">Output</Kicker>
        <div className="hx-agent-io-title">{stage.output.title}</div>
        <div className="hx-mono">{stage.output.detail}</div>
      </div>
    </div>
  );
}
