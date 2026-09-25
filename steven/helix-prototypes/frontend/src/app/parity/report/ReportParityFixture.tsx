"use client";

import { useEffect } from "react";

import { ReportAssembly } from "@/components/ReportAssembly";
import type { Workspace } from "@/lib/types";

import reviewWorkspace from "../review/fixture.json";
import fixture from "./fixture.json";

// Steven's ReportAssembly and ChatDock render unchanged. Their own API calls are answered from
// fixture.json by a browser-side fetch stub installed before the first effect runs; commands
// (POST) are refused with 409 so nothing can change. `?chat=open` opens the dock through its own
// toggle button, exactly as a person would.
const workspace = reviewWorkspace as unknown as Workspace;

type Fixture = {
  sections: unknown[];
  drafts: Record<string, unknown>;
  proposed: Record<string, Record<string, unknown>>;
  chat: unknown[];
};
const data = fixture as unknown as Fixture;

function answer(method: string, path: string): { status: number; body: unknown } {
  if (method !== "GET") return { status: 409, body: { detail: "Parity fixture: display only." } };
  if (/^\/studies\/[^/]+\/sections$/.test(path)) return { status: 200, body: data.sections };
  if (/^\/studies\/[^/]+\/chat$/.test(path)) return { status: 200, body: data.chat };
  const draft = path.match(/^\/studies\/[^/]+\/sections\/([^/]+)\/draft$/);
  if (draft) return { status: 200, body: data.drafts[decodeURIComponent(draft[1])] ?? null };
  const version = path.match(/^\/studies\/[^/]+\/sections\/([^/]+)\/drafts\/(\d+)$/);
  if (version) {
    const value = data.proposed[decodeURIComponent(version[1])]?.[version[2]];
    return value ? { status: 200, body: value } : { status: 404, body: { detail: "Not found." } };
  }
  return { status: 404, body: { detail: "Parity fixture: not stubbed." } };
}

function installStub() {
  const w = window as Window & { __helixReportStub?: boolean };
  if (w.__helixReportStub) return;
  w.__helixReportStub = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = url.match(/\/api\/v1(\/[^?#]*)/);
    if (!match) return original(input, init);
    const { status, body } = answer((init?.method ?? "GET").toUpperCase(), match[1]);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}

export function ReportParityFixture() {
  if (typeof window !== "undefined") installStub();
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("chat") !== "open") return;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="chat-dock"] .chat-title-button')?.click();
    }, 50);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div id="helix-e2e" className="hx-app" data-testid="parity-fixture">
      <main className="hx-main">
        <section className="hx-stage-view" aria-label="Stage view" data-testid="stage-view" data-selected-stage="review-export">
          <ReportAssembly
            workspace={workspace}
            busy={null}
            onInspectClaim={() => undefined}
            onResolve={() => undefined}
            onApprove={() => undefined}
            onFinalStudyApproval={() => undefined}
            onExport={() => undefined}
          />
        </section>
      </main>
    </div>
  );
}
