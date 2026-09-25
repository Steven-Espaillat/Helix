import type { JourneyStageId } from "@/lib/types";

// Lane B (#21). The six Agent Step stages (2-7) that share one view.
export const AGENT_STAGE_IDS = ["parse", "resolve", "extract", "validate", "draft", "provenance"] as const;

export type AgentStageId = (typeof AGENT_STAGE_IDS)[number];

export function isAgentStageId(value: JourneyStageId | string | null | undefined): value is AgentStageId {
  return Boolean(value && (AGENT_STAGE_IDS as readonly string[]).includes(value));
}
