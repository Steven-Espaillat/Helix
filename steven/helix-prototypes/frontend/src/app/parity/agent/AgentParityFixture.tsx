"use client";

import { useState } from "react";

import { AgentStageView } from "@/components/agent/AgentStageView";
import { isAgentStageId } from "@/components/agent/stages";
import { ShellHeader } from "@/components/shell/ShellHeader";
import { Pill, StageRail, type StageRailNode } from "@/components/ui";
import type { Workspace } from "@/lib/types";

import { REFERENCE_STAGES } from "../fixtures";
import { AGENT_FIXTURE_STAGE_IDS, agentFixtureWorkspace } from "./agentFixture";

// Lane B (#21). The reference `?stage=N` agent page composed from the real Agent Step
// view over display-only fixture data, so the parity kit compares it against
// research/helix-e2e-workbench-v1.html. The whole composition (header, rail, panel)
// is rendered to keep every element at the same sub-pixel offset as the reference.
// Nothing here calls the API: the fixture is not actionable (the stage is paused).

function railNodes(current: number): StageRailNode[] {
  return REFERENCE_STAGES.map((stage, index) => {
    const gate = "gate" in stage;
    const done = index < current;
    const isCurrent = index === current;
    return {
      key: String(index),
      shortLabel: stage.short,
      name: stage.name,
      kind: gate ? "gate" : "agent",
      state: done ? "done" : isCurrent ? "current" : "pending",
      running: false,
      statusLabel: done ? (gate ? "Approved" : "Done") : isCurrent ? (gate ? "Awaiting you" : "Paused") : gate ? "Human gate" : "Agent",
      disabled: index > current,
    };
  });
}

export function AgentParityFixture({ stage }: { stage: number }) {
  const [selected, setSelected] = useState(String(stage));
  const [workspace, setWorkspace] = useState<Workspace>(() => agentFixtureWorkspace(stage));
  const selectedId = AGENT_FIXTURE_STAGE_IDS[Number(selected)];
  return (
    <div id="helix-e2e" className="hx-app" data-testid="parity-fixture">
      <ShellHeader
        studyId="STUDY-HLX-028"
        descriptor={"28-day oral repeat-dose toxicity \u00b7 Rodent \u00b7 40 animals \u00b7 Sponsor template v5"}
        loaded={false}
        releasePill={<Pill tone="block">Release blocked</Pill>}
      />
      <main className="hx-main">
        <StageRail stages={railNodes(stage)} selectedKey={selected} onSelect={setSelected} data-testid="fixture-rail" />
        <div data-testid="fixture-agent-panel">
          {isAgentStageId(selectedId) && (
            <AgentStageView studyId="STUDY-HLX-028" workspace={workspace} stageId={selectedId} onWorkspace={setWorkspace} />
          )}
        </div>
      </main>
    </div>
  );
}
