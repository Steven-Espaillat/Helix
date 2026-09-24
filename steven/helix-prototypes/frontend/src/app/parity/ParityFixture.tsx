"use client";

import { useState } from "react";

import { CheckIcon, UploadIcon } from "@/components/icons";
import { ShellHeader } from "@/components/shell/ShellHeader";
import {
  Button,
  Card,
  Chip,
  DataTable,
  FileCell,
  GateBanner,
  Kicker,
  ListRow,
  Pill,
  StageRail,
  toneColor,
  type StageRailNode,
} from "@/components/ui";

import { REFERENCE_FILES, REFERENCE_STAGES } from "./fixtures";

// Renders shared components with reference fixture data so the parity kit can
// compare them against research/helix-e2e-workbench-v1.html pixel by pixel.
// Mirrors the reference `?stage=N` deep link (agent not running).

export type FixtureName = "upload";

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
      statusLabel: done
        ? gate
          ? "Approved"
          : "Done"
        : isCurrent
          ? gate
            ? "Awaiting you"
            : "Paused"
          : gate
            ? "Human gate"
            : "Agent",
      disabled: index > current,
    };
  });
}

/**
 * The reference `?stage=N` page composed from the shared components, with the
 * reference fixture copy. Rendering the whole composition (header, rail, gate
 * banner, upload grid) keeps every element at the same sub-pixel offset as in
 * the reference, so the parity diff measures styling, not text rasterization
 * at a different fractional y.
 */
export function ParityFixture({ stage }: { fixture: FixtureName; stage: number }) {
  const [selected, setSelected] = useState(String(stage));
  const locked = stage > 0;
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
        <div className="stack">
          <GateBanner
            gateNumber={1}
            passed={locked}
            title="Upload and authorize study inputs"
            right="The agent cannot start until the study owner authorizes the inputs."
            data-testid="fixture-gate-banner"
          />
          <div className="g-upload">
            <Card stack aria-labelledby="fx-up-h">
              <div>
                <h1 id="fx-up-h">Study inputs</h1>
                <p className="hx-sub">
                  Protocol, template, source data and the approved report pattern. HELIX hashes and freezes each file.
                </p>
              </div>
              {!locked && (
                <div className="hx-drop">
                  <span style={{ color: toneColor("accent"), display: "inline-flex" }}>
                    <UploadIcon />
                  </span>
                  <strong style={{ fontSize: 15 }}>Drag files here</strong>
                  <span className="hx-sub" style={{ margin: 0 }}>
                    PDF, DOCX, CSV or XLSX
                  </span>
                  <label className="hx-btn">
                    Browse files
                    <input type="file" multiple className="hx-sr" />
                  </label>
                </div>
              )}
              <DataTable
                label="Study inputs"
                data-testid="fixture-file-table"
                rows={[...REFERENCE_FILES]}
                rowKey={(row) => row[0]}
                columns={[
                  { key: "file", header: "File", cell: (row) => <FileCell name={row[0]} /> },
                  { key: "type", header: "Type", cell: (row) => row[1], cellClassName: "hx-mono" },
                  { key: "role", header: "Role", cell: (row) => row[2], cellClassName: "hx-cell-ink2" },
                  {
                    key: "status",
                    header: "Status",
                    cell: () => (locked ? <Chip tone="pass">Frozen</Chip> : <Chip tone="muted">Uploaded</Chip>),
                  },
                ]}
              />
            </Card>
            <Card as="aside" stack aria-labelledby="fx-auth-h" data-testid="fixture-auth-card">
              <div>
                <Kicker>Authorization</Kicker>
                <h2 id="fx-auth-h" style={{ marginTop: 4 }}>
                  Freeze the manifest
                </h2>
              </div>
              <div>
                {["10 of 10 required inputs present", "Authority tiers assigned", "No unapproved sources"].map((text) => (
                  <ListRow key={text} icon={<CheckIcon />} iconColor={toneColor("pass")}>
                    {text}
                  </ListRow>
                ))}
              </div>
              <label className="hx-consent">
                <input type="checkbox" defaultChecked={locked} disabled={locked} />
                <span>I authorize these 10 inputs for STUDY-HLX-028. The agent may use only these frozen versions.</span>
              </label>
              <Button variant="primary" disabled>
                {locked ? "Manifest frozen \u00b7 MANIFEST-HLX-028" : "Authorize and start agent"}
              </Button>
              <p className="hx-sub" style={{ margin: 0, fontSize: 12 }}>
                After authorization the agent runs stages 2–7 by itself and stops at the next human gate.
              </p>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
