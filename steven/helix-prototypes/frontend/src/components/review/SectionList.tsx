"use client";

import type { Workspace } from "@/lib/types";

import { Card, Chip, cx, type Tone } from "../ui";

// Lane D (#23): report section list. Renders WorkspaceResponse.report.sections and their
// server statuses; status labels only.

type Section = Workspace["report"]["sections"][number];

const statusPresentation: Record<Section["status"], { label: string; tone: Tone }> = {
  validated: { label: "Ready", tone: "pass" },
  reviewed: { label: "Reviewed", tone: "pass" },
  needs_review: { label: "Needs review", tone: "warn" },
};

export function SectionList({
  workspace,
  selectedId,
  onSelect,
}: {
  workspace: Workspace;
  selectedId: string;
  onSelect: (sectionId: string) => void;
}) {
  return (
    <Card as="nav" className="hx-review-nav" aria-label="Report sections" data-testid="review-sections">
      <div className="hx-kicker hx-review-nav-head">
        {workspace.report.template.name} · Sponsor template {workspace.report.template.version}
      </div>
      {workspace.report.sections.map((section, index) => {
        // Per-section blocker counts were removed upstream by Steven (per Perk); status only.
        const presentation = statusPresentation[section.status] ?? { label: section.status, tone: "muted" as Tone };
        const active = section.section_id === selectedId;
        return (
          <button
            type="button"
            key={section.section_id}
            className={cx("hx-sec", active && "is-active")}
            aria-current={active ? "true" : undefined}
            onClick={() => onSelect(section.section_id)}
            data-testid={`review-section-${section.section_id}`}
          >
            <span className="hx-sec-title">
              {index + 1}. {section.title}
            </span>
            <Chip tone={presentation.tone} size="xs" data-status={section.status}>
              {presentation.label}
            </Chip>
          </button>
        );
      })}
    </Card>
  );
}
