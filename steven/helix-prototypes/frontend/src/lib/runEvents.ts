// Run-event stream client (Steven-Espaillat/Helix#25).
// Reads the backend SSE stream for one Pinned Run. On HTTP 409 `event_cursor_expired`
// (or a terminal `cursor_expired` frame) it refreshes the workspace projection and
// reconnects from the server's latest event.
//
// Deduplication is by sequence: an event whose sequence is <= the last delivered sequence
// is dropped, so a completion is never delivered twice. The cursor lives only for one call:
// CALLERS MUST PERSIST the returned `lastEventId` and pass it back as `lastEventId` on every
// reconnect, otherwise replayed events will be delivered again.
import { API_ROOT, getWorkspace } from "./api";
import type { EventCursorExpired, RunEvent, Workspace } from "./types";

export type RunEventStreamOptions = {
  studyId: string;
  runId: string;
  lastEventId?: string | null;
  onEvent: (event: RunEvent) => void;
  onWorkspaceRefresh?: (workspace: Workspace) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  refreshWorkspace?: (studyId: string) => Promise<Workspace>;
  maxReconnects?: number;
};

export type RunEventStreamResult = {
  lastEventId: string | null;
  delivered: number;
  refreshed: number;
};

export function isEventCursorExpired(value: unknown): value is EventCursorExpired {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === "event_cursor_expired" &&
    typeof (value as { run_id?: unknown }).run_id === "string"
  );
}

export function sequenceOfEventId(eventId: string | null | undefined): number {
  const match = /\.E(\d+)$/.exec(eventId ?? "");
  return match ? Number(match[1]) : 0;
}

type ParsedFrames = { events: RunEvent[]; cursorExpired: EventCursorExpired | null };

export function parseRunEventFrames(text: string): RunEvent[] {
  return parseFrames(text).events;
}

function parseFrames(text: string): ParsedFrames {
  const events: RunEvent[] = [];
  let cursorExpired: EventCursorExpired | null = null;
  for (const block of text.split(/\n\n/)) {
    const isExpiry = block.split("\n").some((line) => line === "event: cursor_expired");
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (!data) continue;
    const value: unknown = JSON.parse(data);
    if (isExpiry) {
      if (isEventCursorExpired(value)) cursorExpired = value;
    } else {
      events.push(value as RunEvent);
    }
  }
  return { events, cursorExpired };
}

export async function streamRunEvents(options: RunEventStreamOptions): Promise<RunEventStreamResult> {
  const fetcher = options.fetchImpl ?? fetch;
  const refresh = options.refreshWorkspace ?? getWorkspace;
  let cursor = options.lastEventId ?? null;
  let lastSequence = sequenceOfEventId(cursor);
  let delivered = 0;
  let refreshed = 0;
  const maxReconnects = options.maxReconnects ?? 1;

  for (let attempt = 0; attempt <= maxReconnects; attempt += 1) {
    const url = `${API_ROOT}/studies/${encodeURIComponent(options.studyId)}/pinned-runs/${encodeURIComponent(options.runId)}/events`;
    const response = await fetcher(url, {
      headers: cursor ? { Accept: "text/event-stream", "Last-Event-ID": cursor } : { Accept: "text/event-stream" },
      cache: "no-store",
      signal: options.signal,
    });
    const reconnectFrom = async (body: EventCursorExpired) => {
      const workspace = await refresh(options.studyId);
      refreshed += 1;
      options.onWorkspaceRefresh?.(workspace);
      cursor = workspace.journey.run?.latest_event_id ?? body.latest_event_id ?? null;
      // The refreshed projection already reflects everything up to this cursor.
      lastSequence = Math.max(lastSequence, sequenceOfEventId(cursor));
    };
    if (response.status === 409) {
      const body: unknown = await response.json();
      if (!isEventCursorExpired(body)) {
        throw new Error("The run-event stream returned an untyped conflict.");
      }
      await reconnectFrom(body);
      continue;
    }
    if (!response.ok || !response.body) {
      throw new Error(`The run-event stream failed with HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let expired: EventCursorExpired | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const boundary = buffer.lastIndexOf("\n\n");
      if (boundary >= 0) {
        const parsed = parseFrames(buffer.slice(0, boundary + 2));
        for (const event of parsed.events) {
          if (event.sequence <= lastSequence) continue;
          lastSequence = event.sequence;
          cursor = event.event_id;
          delivered += 1;
          options.onEvent(event);
        }
        expired = expired ?? parsed.cursorExpired;
        buffer = buffer.slice(boundary + 2);
      }
      if (done) break;
    }
    if (expired) {
      await reconnectFrom(expired);
      continue;
    }
    return { lastEventId: cursor, delivered, refreshed };
  }
  throw new Error("The run-event cursor expired repeatedly; reload the workspace.");
}
