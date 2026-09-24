import type { components } from "./api-schema";

export type Workspace = components["schemas"]["WorkspaceResponse"];
export type ValidationRun = components["schemas"]["ValidationRun"];
export type ValidationResult = components["schemas"]["ValidationResult"];
export type EvidenceChainData = components["schemas"]["EvidenceChain"];
export type Claim = components["schemas"]["Claim"];
export type Stage = components["schemas"]["Stage"];
export type AssembledSection = components["schemas"]["AssembledSection"];
export type ApprovalRole = components["schemas"]["ApprovalRole"];
export type ExportReceipt = components["schemas"]["ExportReceipt"];
export type PlannerMode = components["schemas"]["PlannerMode"];
export type SectionRunReceipt = components["schemas"]["SectionRunReceipt"];
export type DataValidationExecution = components["schemas"]["DataValidationExecution"];
export type CandidateEvaluation = components["schemas"]["CandidateEvaluation"];
export type CrossSectionQueryReceipt = components["schemas"]["CrossSectionQueryReceipt"];
export type SectionDraft = components["schemas"]["SectionDraft"];
export type PromotionDecision = components["schemas"]["PromotionDecision"];
export type HumanDirectedRevisionReceipt = components["schemas"]["HumanDirectedRevisionReceipt"];
export type DraftingCycle = components["schemas"]["DraftingCycle"];

// Backend-owned nine-stage journey and run events (Steven-Espaillat/Helix#25).
export type WorkbenchJourney = components["schemas"]["WorkbenchJourney"];
export type JourneyStage = components["schemas"]["JourneyStage"];
export type JourneyStageId = JourneyStage["stage_id"];
export type JourneyAction = components["schemas"]["JourneyAction"];
export type JourneyRunIdentity = components["schemas"]["JourneyRunIdentity"];
export type RunEvent = NonNullable<WorkbenchJourney["latest_event"]>;
export type EventCursorExpired = components["schemas"]["EventCursorExpired"];
