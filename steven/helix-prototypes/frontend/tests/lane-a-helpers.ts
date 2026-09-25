import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page, Route } from "@playwright/test";

// Lane A test helpers. The freeze fixture is test-local: it was produced by freezing the
// seeded study against a temporary qualified copy of the governed tree (see its _note).

export type Json = Record<string, unknown>;
export type Stage = Json & { stage_id: string; kind: string; status: string; selectable: boolean };
export type Journey = Json & { current_stage_id: string | null; stages: Stage[]; latest_event: Json | null };

export const apiRoot = process.env.HELIX_API_URL ?? "http://127.0.0.1:8000/api/v1";
export const studyId = "STUDY-HLX-028";
export const regulatoryClaim =
  /FDA[- ]approv|approved by (the )?FDA|FDA[- ]complian|compliant with (the )?FDA|submission[- ]read|ready for submission/i;

export const freezeFixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/lane-a-freeze.json"), "utf8"),
) as { before: Json & { journey: Journey }; after: Json & { journey: Journey; pinned_run: Json & { run_id: string } } };

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Serve the live workspace with fields replaced by `patch(workspace)`. */
export async function serveWorkspace(page: Page, patch: (workspace: Json) => Json) {
  await page.route("**/api/v1/studies/*/workspace", async (route: Route) => {
    const workspace = await liveWorkspace(route);
    if (workspace) await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(patch(workspace)) });
  });
}

/** Fetch the live workspace for a routed request; null if the page closed mid-request. */
export async function liveWorkspace(route: Route): Promise<Json | null> {
  try {
    const response = await route.fetch();
    return (await response.json()) as Json;
  } catch (error) {
    if (/disposed|closed|Target page/i.test(String(error))) return null;
    throw error;
  }
}

export function withJourney(journey: Journey) {
  return (workspace: Json): Json => ({ ...workspace, journey });
}

export function frozenWorkspace(workspace: Json, overrides: Json = {}): Json {
  const after = clone(freezeFixture.after);
  return {
    ...workspace,
    pinned_run: after.pinned_run,
    data_validation_executions: after.data_validation_executions,
    journey: after.journey,
    ...overrides,
  };
}

/** Rebuild a journey where `current` is reached and every earlier stage is complete. */
export function journeyAt(current: string, status: "current" | "blocked" | "paused" = "current", running = false): Journey {
  const journey = clone(freezeFixture.after.journey);
  const index = journey.stages.findIndex((stage) => stage.stage_id === current);
  journey.stages = journey.stages.map((stage, position) => ({
    ...stage,
    status: position < index ? "complete" : position === index ? status : "pending",
    selectable: position <= index,
  }));
  journey.current_stage_id = current;
  journey.latest_event = running
    ? { ...(journey.latest_event ?? {}), stage_id: current, type: "stage_started" }
    : { ...(journey.latest_event ?? {}), stage_id: current, type: "gate_waiting" };
  return journey;
}

export function stageButtons(page: Page) {
  return page.getByRole("navigation", { name: "Journey progress" }).getByRole("button");
}

/** Record every non-GET request the page sends to the API. */
export function trackCommands(page: Page): string[] {
  const commands: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/") && request.method() !== "GET") {
      commands.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  return commands;
}
