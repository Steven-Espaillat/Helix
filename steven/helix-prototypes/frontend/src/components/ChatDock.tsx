"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  ApiError,
  applySection,
  discardSection,
  getChat,
  getSectionDraftVersion,
  sendChat,
} from "@/lib/api";
import type { ChatMessage, SectionContentDraft } from "@/lib/types";

import { CheckIcon, ChevronIcon, CloseIcon, FileIcon } from "./icons";

type Props = {
  studyId: string;
  sectionId: string;
  sectionTitle: string;
  onApplied?: () => void;
};

export function ChatDock({ studyId, sectionId, sectionTitle, onApplied }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposed, setProposed] = useState<SectionContentDraft | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<null | "send" | "apply">(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef(`${studyId}:${sectionId}`);
  selectionRef.current = `${studyId}:${sectionId}`;

  useEffect(() => {
    let active = true;
    setProposed(null);
    getChat(studyId)
      .then(async (value) => {
        if (!active) return;
        setMessages(value);
        const versions = new Set<number>();
        for (const message of [...value].reverse()) {
          if (
            message.role === "assistant" &&
            message.section_id === sectionId &&
            typeof message.draft_version === "number"
          ) {
            versions.add(message.draft_version);
          }
        }
        for (const version of versions) {
          const draft = await getSectionDraftVersion(studyId, sectionId, version);
          if (active && draft.status === "proposed") {
            setProposed(draft);
            return;
          }
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [studyId, sectionId]);

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, proposed, open]);

  function note(content: string) {
    setMessages((prev) => [
      ...prev,
      {
        message_id: -Date.now() - Math.random(),
        role: "assistant",
        content,
        scope: "section",
        section_id: sectionId,
        intent: "ask",
        created_at: new Date().toISOString(),
      },
    ]);
  }

  async function send() {
    const text = input.trim();
    const selection = `${studyId}:${sectionId}`;
    if (!text || busy) return;
    setBusy("send");
    setError(null);
    setOpen(true);
    setInput("");
    setMessages((prev) => [
      ...prev,
      {
        message_id: -Date.now(),
        role: "user",
        content: text,
        scope: "section",
        section_id: sectionId,
        intent: "ask",
        created_at: new Date().toISOString(),
      },
    ]);
    try {
      const turn = await sendChat(studyId, text, "section", sectionId);
      setMessages(await getChat(studyId));
      if (turn.proposed && selectionRef.current === selection) {
        setProposed(turn.proposed);
      }
    } catch (cause) {
      setError(toMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!proposed || busy) return;
    setBusy("apply");
    setError(null);
    try {
      await applySection(studyId, proposed.section_id, proposed.version);
      note(`Applied v${proposed.version} to “${proposed.title}”.`);
      setProposed(null);
      onApplied?.();
    } catch (cause) {
      setError(toMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    if (!proposed || busy) return;
    setBusy("apply");
    setError(null);
    try {
      await discardSection(studyId, proposed.section_id, proposed.version);
      note(`Discarded v${proposed.version}. Describe the change differently to try again.`);
      setProposed(null);
    } catch (cause) {
      setError(toMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const proposedProse = proposed?.blocks
    .filter((block) => block.kind === "prose")
    .map((block) => (block.kind === "prose" ? block.markdown : ""))
    .join("\n\n");

  return (
    <div className={open ? "chat-dock open" : "chat-dock"} data-testid="chat-dock">
      <div className="chat-header">
        <button
          type="button"
          className="chat-title-button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className="chat-glyph" aria-hidden="true">
            <FileIcon />
          </span>
          <span className="chat-title">
            Assistant
            <strong>{sectionTitle}</strong>
          </span>
          <span
            className="chat-chevron"
            aria-hidden="true"
            style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : "rotate(-90deg)" }}
          >
            <ChevronIcon />
          </span>
        </button>
      </div>

      {open && (
        <div className="chat-body">
          <div className="chat-messages" ref={listRef}>
            {messages.length === 0 && !proposed && (
              <p className="chat-empty">
                Ask about the study or this section, or describe a change to “{sectionTitle}”. I
                answer questions, and when you ask for a change I propose a rewrite you Apply or
                Discard.
              </p>
            )}
            {messages.map((message) => (
              <div key={message.message_id} className={`chat-msg ${message.role}`}>
                <div className="chat-bubble">
                  {message.role === "assistant" ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                  ) : (
                    message.content
                  )}
                </div>
              </div>
            ))}
            {busy === "send" && (
              <div className="chat-msg assistant">
                <div className="chat-bubble typing">Thinking…</div>
              </div>
            )}
            {proposed && (
              <div className="proposed-card hx-card" data-testid="proposed-card">
                <div className="proposed-head">
                  <strong>Proposed rewrite · v{proposed.version}</strong>
                  <span>{proposed.title}</span>
                </div>
                <div className="proposed-body draft-prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {proposedProse || "(no narrative change)"}
                  </ReactMarkdown>
                </div>
                <div className="proposed-actions">
                  <button
                    className="button small thumbs-up hx-btn sm primary"
                    type="button"
                    onClick={() => void apply()}
                    disabled={busy !== null}
                    data-testid="apply-proposed"
                  >
                    <CheckIcon size={14} /> Apply
                  </button>
                  <button
                    className="button small thumbs-down hx-btn sm"
                    type="button"
                    onClick={() => void discard()}
                    disabled={busy !== null}
                    data-testid="discard-proposed"
                  >
                    <CloseIcon size={14} /> Discard
                  </button>
                </div>
              </div>
            )}
          </div>
          {error && <div className="chat-error hx-notice t-block">{error}</div>}
        </div>
      )}

      <form
        className="chat-input-row"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          className="chat-input"
          value={input}
          placeholder={`Ask about the study, or describe a change to “${sectionTitle}”…`}
          onChange={(event) => setInput(event.target.value)}
          onFocus={() => setOpen(true)}
          data-testid="chat-input"
        />
        <button className="button primary small hx-btn sm primary" type="submit" disabled={busy !== null || !input.trim()}>
          {busy === "send" ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

function toMessage(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) {
    return cause.message;
  }
  return "Request failed.";
}
