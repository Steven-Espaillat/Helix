// Compile-time contract checks for the generated nine-stage journey (Steven-Espaillat/Helix#25).
// `npm run typecheck` fails if the generated types regress to the legacy ten-stage shape.
import type { JourneyStage, JourneyStageId, Stage, Workspace } from "./types";

type Assert<T extends true> = T;
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type NineStageIds = Assert<
  Equals<
    JourneyStageId,
    | "upload"
    | "parse"
    | "resolve"
    | "extract"
    | "validate"
    | "draft"
    | "provenance"
    | "traceability"
    | "review-export"
  >
>;
export type WorkspaceCarriesJourney = Assert<Equals<Workspace["journey"]["stages"][number], JourneyStage>>;
export type JourneyIsNotLegacyStage = Assert<Equals<JourneyStage extends Stage ? true : false, false>>;

export function legacyShapeIsRejected(stage: JourneyStage): string {
  // @ts-expect-error The legacy ten-stage `owner` field is not part of the projection.
  const owner: string = stage.owner;
  // @ts-expect-error Legacy ten-stage identifiers are not journey stage ids.
  const legacyId: JourneyStageId = "authorized-upload";
  return `${owner}${legacyId}`;
}
