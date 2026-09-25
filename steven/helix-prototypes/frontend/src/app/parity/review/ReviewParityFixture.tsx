"use client";

import { ProgressBar } from "@/components/journey/ProgressBar";
import { ReviewStageView } from "@/components/review/ReviewStageView";
import { ShellHeader } from "@/components/shell/ShellHeader";
import { Pill } from "@/components/ui";
import type { Workspace } from "@/lib/types";

import fixture from "./fixture.json";

// Display-only: commands are no-ops so the fixture can never reach the API. The page keeps the
// reference composition (header, Progress Bar, stage panel) so every element sits at the same
// sub-pixel offset as research/helix-e2e-workbench-v1.html?stage=8.
const workspace = fixture as unknown as Workspace;

export function ReviewParityFixture() {
  return (
    <div id="helix-e2e" className="hx-app" data-testid="parity-fixture">
      <ShellHeader
        studyId="STUDY-HLX-028"
        descriptor={"28-day oral repeat-dose toxicity \u00b7 Rodent \u00b7 40 animals \u00b7 Sponsor template v5"}
        loaded={false}
        releasePill={<Pill tone="block">Release blocked</Pill>}
      />
      <main className="hx-main">
        <ProgressBar journey={workspace.journey} selectedStageId="review-export" onSelect={() => undefined} />
        <section className="hx-stage-view" aria-label="Stage view" data-testid="stage-view" data-selected-stage="review-export">
          <ReviewStageView workspace={workspace} onWorkspace={() => undefined} onRefresh={async () => undefined} />
        </section>
      </main>
    </div>
  );
}
