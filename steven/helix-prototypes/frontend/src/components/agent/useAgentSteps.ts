"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, getWorkspace, reviseSection, runSectionAgent } from "@/lib/api";
import {
  BODY_WEIGHT_SECTION,
  executeAgentStep,
  isAgentStep,
  nextAgentStep,
  runAgentSequence,
  type AgentStep,
  type AgentStepReceipt,
  type NextStepOptions,
} from "@/lib/api/agentSteps";
import { streamRunEvents } from "@/lib/runEvents";
import type { PlannerMode, Workspace } from "@/lib/types";

import { humanDecisions, type HumanDecision, type HumanDecisionId } from "./humanDecisions";

// Lane B (#21). The Agent Step command handlers, kept out of the shared workbench.
// The server is the authority: every decision reads a freshly fetched Workspace, one
// command runs at a time (shared with the legacy controls via onBusyChange), and a failure stops the sequence. While a command is in
// flight the hook follows #25's run-event stream for the Pinned Run and refreshes the
// Workspace on each server event, so activity rows come from the projection, never
// from local progress. Nothing here runs on a timer.

export type AgentMessage = { tone: "info" | "block"; text: string };

type Eligibility = Workspace["section_run_eligibility"][number];

export type EligibilityChange = { before: Eligibility | null; after: Eligibility | null };

export type AgentReceipts = Partial<{ [K in AgentStepReceipt["action"]]: Extract<AgentStepReceipt, { action: K }>["value"] }>;

type Options = {
  studyId: string;
  workspace: Workspace;
  onWorkspace: (workspace: Workspace) => void;
  /**
   * Reports whether an agent command is in flight, so the workbench can disable the legacy
   * StudyJourney controls (one command at a time across both). Called from the command
   * itself, not an effect, so it stays true if this view unmounts mid-command.
   * DH-2 (#66): `follow` is false for a person's Draft-stage decision, so the view stays on
   * Draft instead of following the server stage (DH-1); it defaults to `busy`.
   */
  onBusyChange?: (busy: boolean, follow?: boolean) => void;
  /**
   * DH-1 follow-up: reports a sequence that stopped at a human gate. The view follows the
   * server to that gate and unmounts this stage, so the workbench shows the message.
   */
  onGateStop?: (message: string) => void;
};

const CONFIRMED_KEY = "helix.agent-dv-confirmed.v1";

function readConfirmed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(CONFIRMED_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function eligibilityOf(workspace: Workspace): Eligibility | null {
  return workspace.section_run_eligibility.find((item) => item.section_package_id === BODY_WEIGHT_SECTION) ?? null;
}

export function messageFrom(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "The request failed.";
}

export function useAgentSteps({ studyId, workspace, onWorkspace, onBusyChange, onGateStop }: Options) {
  const [planner, setPlanner] = useState<PlannerMode>("fixture");
  const [inFlight, setInFlight] = useState<AgentStep | null>(null);
  const [humanInFlight, setHumanInFlight] = useState<HumanDecision | null>(null);
  const [message, setMessage] = useState<AgentMessage | null>(null);
  const [receipts, setReceipts] = useState<AgentReceipts>({});
  const [eligibilityChange, setEligibilityChange] = useState<EligibilityChange | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(() => new Set());
  // DH-1: a running sequence and a pending operator stop. The stop is honoured before the
  // next governed command; the command already sent to the server always settles.
  const [sequenceRunning, setSequenceRunning] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const stopRef = useRef(false);
  const confirmedRef = useRef<Set<string>>(new Set());
  // Set synchronously before any await, so a double click cannot start a second command
  // or sequence before React re-renders the disabled button.
  const runningRef = useRef(false);
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const onGateStopRef = useRef(onGateStop);
  onGateStopRef.current = onGateStop;

  const begin = useCallback((follow = true): boolean => {
    if (runningRef.current) return false;
    runningRef.current = true;
    onBusyChangeRef.current?.(true, follow);
    return true;
  }, []);
  const end = useCallback(() => {
    runningRef.current = false;
    onBusyChangeRef.current?.(false);
  }, []);

  // Last-wins Workspace refreshes. Every fetch this hook starts (commands and run events)
  // takes a sequence number, and a response is shown only if no newer fetch was shown, so a
  // slow older projection never overwrites a newer one. Decisions always use the fetch's
  // own result.
  const issuedRef = useRef(0);
  const appliedRef = useRef(0);
  const onWorkspaceRef = useRef(onWorkspace);
  onWorkspaceRef.current = onWorkspace;
  const showIfNewest = useCallback((seq: number, next: Workspace) => {
    if (seq <= appliedRef.current) return;
    appliedRef.current = seq;
    onWorkspaceRef.current(next);
  }, []);
  const refresh = useCallback(async (): Promise<Workspace> => {
    const seq = ++issuedRef.current;
    const next = await getWorkspace(studyId);
    showIfNewest(seq, next);
    return next;
  }, [studyId, showIfNewest]);

  useEffect(() => {
    const stored = readConfirmed();
    confirmedRef.current = stored;
    setConfirmed(stored);
  }, []);

  const options = useCallback((): NextStepOptions => ({ confirmedDataValidationRuns: confirmedRef.current }), []);

  const record = useCallback((_step: AgentStep, receipt: AgentStepReceipt, before: Workspace, after: Workspace) => {
    setReceipts((current) => ({ ...current, [receipt.action]: receipt.value }));
    if (receipt.action === "validation") {
      setEligibilityChange({ before: eligibilityOf(before), after: eligibilityOf(after) });
    }
    if (receipt.action === "data-validation") {
      const runId = receipt.value.receipt.run_id;
      const next = new Set(confirmedRef.current).add(runId);
      confirmedRef.current = next;
      setConfirmed(next);
      window.sessionStorage.setItem(CONFIRMED_KEY, JSON.stringify([...next]));
    }
  }, []);

  // #25: follow the server's run events while a command is in flight; each event refreshes
  // the projection. The stream closes when the command settles (abort), never on a timer.
  const runId = workspace.pinned_run?.run_id ?? null;
  const cursor = workspace.journey.run?.latest_event_id ?? null;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const following = Boolean(inFlight || humanInFlight);
  useEffect(() => {
    if (!following || !runId) return;
    const controller = new AbortController();
    void streamRunEvents({
      studyId,
      runId,
      lastEventId: cursorRef.current,
      signal: controller.signal,
      onEvent: () => {
        void refresh().catch(() => undefined);
      },
      onWorkspaceRefresh: (next) => showIfNewest(++issuedRef.current, next),
    }).catch(() => undefined); // The command's own refresh stays the fallback authority.
    return () => controller.abort();
  }, [following, runId, studyId, refresh, showIfNewest]);

  // `follow` false: started from a Draft follow-up on a completed Draft stage (DH-2), so the
  // view stays on Draft instead of following the server stage (DH-1).
  const runStep = useCallback(async (follow = true) => {
    if (!begin(follow)) return;
    setMessage(null);
    let next: AgentStep | null = null;
    try {
      // Decide from a freshly fetched Workspace, never the (possibly stale) rendered one.
      const before = await refresh();
      const decided = nextAgentStep(before, options());
      if (!isAgentStep(decided)) {
        setMessage({ tone: "info", text: decided.message });
        return;
      }
      next = decided;
      setInFlight(decided);
      const receipt = await executeAgentStep(studyId, before, decided, planner);
      const after = await refresh();
      record(decided, receipt, before, after);
      setMessage({
        tone: "info",
        text:
          receipt.action === "data-validation" && receipt.value.receipt.idempotent_replay
            ? `${decided.label}: the server returned the recorded execution ${receipt.value.receipt.receipt_id} as an idempotent replay.`
            : `${decided.label}: recorded by the server.`,
      });
    } catch (cause) {
      try {
        await refresh();
      } catch {
        // Keep the last server state; the error below explains what failed.
      }
      const label = (next as AgentStep | null)?.label;
      setMessage({ tone: "block", text: `${label ? `${label} failed. ` : ""}${messageFrom(cause)}` });
    } finally {
      setInFlight(null);
      end();
    }
  }, [begin, end, refresh, options, studyId, planner, record]);

  const runSequence = useCallback(async (follow = true) => {
    if (!begin(follow)) return;
    setMessage(null);
    stopRef.current = false;
    setStopRequested(false);
    setSequenceRunning(true);
    let current: AgentStep | null = null;
    try {
      const stop = await runAgentSequence(studyId, planner, {
        fetchWorkspace: refresh, // shown last-wins as it arrives
        onWorkspace: () => undefined,
        onStep: (value) => {
          if (value) current = value;
          setInFlight(value);
        },
        onReceipt: record,
        options,
        shouldStop: () => stopRef.current,
      });
      if (stop) setMessage({ tone: "info", text: stop.message });
      if (stop?.kind === "gate") onGateStopRef.current?.(stop.message);
    } catch (cause) {
      const label = (current as AgentStep | null)?.label;
      try {
        await refresh();
      } catch {
        // Keep the last server state.
      }
      setMessage({
        tone: "block",
        text: `${label ? `${label} failed. ` : ""}${messageFrom(cause)} The agent stopped; later steps did not run.`,
      });
    } finally {
      stopRef.current = false;
      setStopRequested(false);
      setSequenceRunning(false);
      end();
    }
  }, [begin, end, refresh, studyId, planner, record, options]);

  const stop = useCallback(() => {
    stopRef.current = true;
    setStopRequested(true);
  }, []);

  // DH-2 (#66): a person's Draft-stage decision (retry, revise, first attempt in a new cycle),
  // formerly offered only by the legacy StudyJourney. Same one-command lock as the agent, and
  // availability is re-read from a fresh Workspace before anything is sent.
  const runHumanDecision = useCallback(
    async (id: HumanDecisionId) => {
      if (!begin(false)) return;
      setMessage(null);
      let chosen: HumanDecision | null = null;
      try {
        const before = await refresh();
        chosen = humanDecisions(studyId, before).find((item) => item.id === id) ?? null;
        if (!chosen) {
          setMessage({ tone: "info", text: "The server no longer offers that decision; nothing was sent." });
          return;
        }
        setHumanInFlight(chosen);
        if (chosen.id === "revise") {
          const receipt = await reviseSection(studyId, chosen.idempotencyKey);
          await refresh();
          setMessage({
            tone: "info",
            text: `${receipt.cycle.cycle_id} opened from ${receipt.cycle.predecessor_cycle_id ?? "no predecessor"}.`,
          });
        } else {
          const receipt = await runSectionAgent(studyId, chosen.idempotencyKey);
          const after = await refresh();
          record(
            { action: "section-run", stageId: "draft", label: chosen.label },
            { action: "section-run", value: receipt },
            before,
            after,
          );
          setMessage({ tone: "info", text: `${chosen.label}: ${receipt.candidate_id} recorded by the server.` });
        }
      } catch (cause) {
        try {
          await refresh();
        } catch {
          // Keep the last server state; the error below explains what failed.
        }
        setMessage({ tone: "block", text: `${chosen ? `${chosen.label} failed. ` : ""}${messageFrom(cause)}` });
      } finally {
        setHumanInFlight(null);
        end();
      }
    },
    [begin, end, refresh, studyId, record],
  );

  return {
    planner,
    setPlanner,
    inFlight,
    humanInFlight,
    humanDecisions: humanDecisions(studyId, workspace),
    runHumanDecision: (id: HumanDecisionId) => void runHumanDecision(id),
    message,
    dismissMessage: () => setMessage(null),
    receipts,
    eligibilityChange,
    next: nextAgentStep(workspace, { confirmedDataValidationRuns: confirmed }),
    // A click passes an event here, so only an explicit `false` turns following off.
    runStep: (follow?: unknown) => void runStep(follow !== false),
    runSequence: (follow?: unknown) => void runSequence(follow !== false),
    sequenceRunning,
    stopRequested,
    stop,
  };
}
