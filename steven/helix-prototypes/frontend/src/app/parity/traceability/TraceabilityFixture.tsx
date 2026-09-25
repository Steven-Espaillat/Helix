"use client";

import { useState } from "react";

import { ShellHeader } from "@/components/shell/ShellHeader";
import { TraceabilityStageView } from "@/components/traceability/TraceabilityStageView";
import { Pill, StageRail, type StageRailNode } from "@/components/ui";

import { REFERENCE_STAGES } from "../fixtures";
import { gate2Chain, gate2Workspace } from "./gate2Fixture";

// Lane C (#22). The reference `?stage=7` page (header, rail, #hx-panel) with the real
// TraceabilityStageView over fixture display state, so the parity diff measures the
// view's styling at the same sub-pixel offset as the reference. Commands are inert:
// a disposition is rejected in the form and Continue does nothing.

const GATE_STAGE = 7;

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
      statusLabel: done ? (gate ? "Approved" : "Done") : isCurrent ? "Awaiting you" : gate ? "Human gate" : "Agent",
      disabled: index > current,
    };
  });
}

const loadEvidence = async () => gate2Chain;

async function rejectDisposition(): Promise<never> {
  throw new Error("Parity fixture: dispositions are not recorded.");
}

export function TraceabilityFixture() {
  const [selected, setSelected] = useState(String(GATE_STAGE));
  return (
    <div id="helix-e2e" className="hx-app" data-testid="parity-fixture-traceability">
      <ShellHeader
        studyId="STUDY-HLX-028"
        descriptor={"28-day oral repeat-dose toxicity \u00b7 Rodent \u00b7 40 animals \u00b7 Sponsor template v5"}
        loaded={false}
        releasePill={<Pill tone="block">Release blocked</Pill>}
      />
      <main className="hx-main">
        <StageRail stages={railNodes(GATE_STAGE)} selectedKey={selected} onSelect={setSelected} data-testid="fixture-rail" />
        <div>
          <TraceabilityStageView
            workspace={gate2Workspace}
            loadEvidence={loadEvidence}
            onRecordDisposition={rejectDisposition}
            onContinue={() => undefined}
          />
        </div>
      </main>
    </div>
  );
}
