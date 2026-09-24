// Run-event client contract (Steven-Espaillat/Helix#25). Runs in Node without a browser:
// the fake fetch stands in for the backend SSE endpoint and its typed 409 cursor expiry.
import { expect, test } from "@playwright/test";

import { streamRunEvents } from "../src/lib/runEvents";
import type { RunEvent, Workspace } from "../src/lib/types";

const RUN_ID = "RUN-0123456789ABCDEF";
const LABEL = "SYNTHETIC / NOT FOR SUBMISSION";

function event(sequence: number, type: string, extra: Record<string, unknown> = {}) {
  return {
    label: LABEL,
    event_id: `${RUN_ID}.E${String(sequence).padStart(6, "0")}`,
    run_id: RUN_ID,
    study_id: "STUDY-HLX-028",
    sequence,
    stage_id: "review-export",
    occurred_at: "2026-09-24T20:00:00Z",
    type,
    ...extra,
  };
}

function frame(value: ReturnType<typeof event>): string {
  return `id: ${value.event_id}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("expired cursor refreshes the workspace and reconnects without duplicating completion", async () => {
  const requests: Array<string | null> = [];
  const finished = event(5, "stage_finished");
  const exported = event(6, "export_finished", { artifact_count: 3 });
  const stream = frame(finished) + frame(exported) + frame(exported) + "retry: 3000\n\n";
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push(headers["Last-Event-ID"] ?? null);
    if (requests.length === 1) {
      return new Response(
        JSON.stringify({
          label: LABEL,
          code: "event_cursor_expired",
          detail: "expired",
          run_id: RUN_ID,
          run_version: "sha256:abc",
          latest_event_id: `${RUN_ID}.E000004`,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    // Split mid-frame to prove buffering across chunks.
    return sseResponse([stream.slice(0, 37), stream.slice(37)]);
  }) as typeof fetch;
  const refreshed: Workspace[] = [];
  const delivered: RunEvent[] = [];

  const result = await streamRunEvents({
    studyId: "STUDY-HLX-028",
    runId: RUN_ID,
    lastEventId: `${RUN_ID}.E000001`,
    fetchImpl: fakeFetch,
    refreshWorkspace: async () =>
      ({ journey: { run: { latest_event_id: `${RUN_ID}.E000004` } } }) as unknown as Workspace,
    onWorkspaceRefresh: (workspace) => refreshed.push(workspace),
    onEvent: (value) => delivered.push(value),
  });

  expect(requests).toEqual([`${RUN_ID}.E000001`, `${RUN_ID}.E000004`]);
  expect(refreshed).toHaveLength(1);
  expect(delivered.map((item) => item.type)).toEqual(["stage_finished", "export_finished"]);
  expect(delivered.filter((item) => item.type === "export_finished")).toHaveLength(1);
  expect(result).toEqual({ lastEventId: exported.event_id, delivered: 2, refreshed: 1 });
});

test("an untyped conflict is not treated as cursor expiry", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ detail: "conflict" }), { status: 409 })) as typeof fetch;
  await expect(
    streamRunEvents({ studyId: "STUDY-HLX-028", runId: RUN_ID, fetchImpl: fakeFetch, onEvent: () => {} }),
  ).rejects.toThrow("untyped conflict");
});

test("the same frames sent twice call onEvent once per sequence, across reconnects", async () => {
  const frames = [event(5, "stage_finished"), event(6, "export_finished", { artifact_count: 3 })]
    .map(frame)
    .join("");
  const fakeFetch = (async () => sseResponse([frames, frames])) as typeof fetch;
  const delivered: number[] = [];

  const first = await streamRunEvents({
    studyId: "STUDY-HLX-028",
    runId: RUN_ID,
    lastEventId: `${RUN_ID}.E000004`,
    fetchImpl: fakeFetch,
    onEvent: (value) => delivered.push(value.sequence),
  });
  // The caller persists lastEventId and passes it back on reconnect; replays are dropped.
  const second = await streamRunEvents({
    studyId: "STUDY-HLX-028",
    runId: RUN_ID,
    lastEventId: first.lastEventId,
    fetchImpl: fakeFetch,
    onEvent: (value) => delivered.push(value.sequence),
  });

  expect(delivered).toEqual([5, 6]);
  expect(first).toEqual({ lastEventId: `${RUN_ID}.E000006`, delivered: 2, refreshed: 0 });
  expect(second).toEqual({ lastEventId: `${RUN_ID}.E000006`, delivered: 0, refreshed: 0 });
});

test("a terminal cursor_expired frame refreshes the workspace and reconnects", async () => {
  const expiredFrame = `event: cursor_expired\ndata: ${JSON.stringify({
    label: LABEL,
    code: "event_cursor_expired",
    detail: "expired",
    run_id: RUN_ID,
    run_version: "sha256:abc",
    latest_event_id: `${RUN_ID}.E000009`,
  })}\n\n`;
  const requests: Array<string | null> = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push(headers["Last-Event-ID"] ?? null);
    return requests.length === 1
      ? sseResponse([frame(event(3, "stage_started")), expiredFrame])
      : sseResponse([frame(event(10, "stage_finished"))]);
  }) as typeof fetch;
  const delivered: number[] = [];
  const result = await streamRunEvents({
    studyId: "STUDY-HLX-028",
    runId: RUN_ID,
    lastEventId: `${RUN_ID}.E000002`,
    fetchImpl: fakeFetch,
    refreshWorkspace: async () =>
      ({ journey: { run: { latest_event_id: `${RUN_ID}.E000009` } } }) as unknown as Workspace,
    onEvent: (value) => delivered.push(value.sequence),
  });
  expect(requests).toEqual([`${RUN_ID}.E000002`, `${RUN_ID}.E000009`]);
  expect(delivered).toEqual([3, 10]);
  expect(result.refreshed).toBe(1);
});
