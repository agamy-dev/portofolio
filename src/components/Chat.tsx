"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatEvent, ChatTurn } from "@/lib/chat-protocol";

type Source = { title: string; quote: string };
type Segment = { text: string; sources: number[] }; // indexes into the message's sources
type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; segments: Segment[]; sources: Source[]; error?: string; pending: boolean };

const SUGGESTIONS = [
  "What kind of AI projects do you build?",
  "Can you add an AI assistant to my website?",
  "How does a project with you usually work?",
];

function assistantText(m: Extract<Message, { role: "assistant" }>) {
  return m.segments.map((s) => s.text).join("");
}

function applyEvent(msg: Extract<Message, { role: "assistant" }>, event: ChatEvent) {
  const segments = [...msg.segments];
  const last = () => segments[segments.length - 1] ?? { text: "", sources: [] };
  switch (event.type) {
    case "block":
      return { ...msg, segments: [...segments, { text: "", sources: [] }] };
    case "text": {
      const seg = last();
      segments[Math.max(segments.length - 1, 0)] = { ...seg, text: seg.text + event.text };
      return { ...msg, segments };
    }
    case "citation": {
      const sources = [...msg.sources];
      let idx = sources.findIndex((s) => s.title === event.title && s.quote === event.quote);
      if (idx === -1) idx = sources.push({ title: event.title, quote: event.quote }) - 1;
      const seg = last();
      if (!seg.sources.includes(idx)) {
        segments[Math.max(segments.length - 1, 0)] = { ...seg, sources: [...seg.sources, idx] };
      }
      return { ...msg, segments, sources };
    }
    case "error":
      return { ...msg, error: event.message };
    case "done":
      return { ...msg, pending: false };
  }
}

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setInput("");
    setBusy(true);

    // Only completed turns go back to the server; failed turns are dropped from the history.
    const history: ChatTurn[] = [];
    for (let i = 0; i + 1 < messages.length; i += 2) {
      const [u, a] = [messages[i], messages[i + 1]];
      if (u.role === "user" && a.role === "assistant" && !a.error && assistantText(a)) {
        history.push({ role: "user", content: u.text }, { role: "assistant", content: assistantText(a) });
      }
    }
    history.push({ role: "user", content: question });

    const update = (fn: (m: Extract<Message, { role: "assistant" }>) => Message) =>
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") next[next.length - 1] = fn(last);
        return next;
      });

    setMessages((prev) => [
      ...prev,
      { role: "user", text: question },
      { role: "assistant", segments: [], sources: [], pending: true },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Something went wrong. Please try again.");
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            const event = JSON.parse(line) as ChatEvent;
            update((m) => applyEvent(m, event));
          }
        }
      }
    } catch (err) {
      update((m) => ({ ...m, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      update((m) => ({ ...m, pending: false }));
      setBusy(false);
    }
  }

  return (
    <section className="flex h-[min(680px,80vh)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-accent" />
        </span>
        <div>
          <p className="text-sm font-medium">Portfolio assistant</p>
          <p className="text-xs text-muted">Answers from my portfolio, with sources</p>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto px-5 py-5" aria-live="polite">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted">Ask anything about my work, or try one of these:</p>
            <div className="flex flex-col items-start gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-border px-3.5 py-1.5 text-left text-sm transition hover:border-accent hover:text-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-sm text-accent-contrast">
                {m.text}
              </p>
            </div>
          ) : (
            <AssistantMessage key={i} message={m} />
          ),
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2 border-t border-border p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={2000}
          placeholder="Ask about projects, services, process…"
          aria-label="Your question"
          className="min-w-0 flex-1 rounded-xl border border-border bg-background px-4 py-2.5 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-contrast transition disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}

function AssistantMessage({ message }: { message: Extract<Message, { role: "assistant" }> }) {
  const empty = !assistantText(message);
  return (
    <div className="max-w-[92%] space-y-2">
      {empty && message.pending && (
        <p className="flex gap-1 py-2" aria-label="Thinking">
          {[0, 150, 300].map((d) => (
            <span key={d} className="size-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: `${d}ms` }} />
          ))}
        </p>
      )}
      {!empty && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {message.segments.map((seg, i) => (
            <span key={i}>
              {seg.text}
              {seg.sources.map((s) => (
                <sup key={s} className="ml-0.5 font-medium text-accent">
                  [{s + 1}]
                </sup>
              ))}
            </span>
          ))}
        </p>
      )}
      {message.error && <p className="text-sm text-red-600 dark:text-red-400">{message.error}</p>}
      {message.sources.length > 0 && !message.pending && (
        <details className="rounded-lg border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted">
            {message.sources.length} source{message.sources.length > 1 ? "s" : ""}
          </summary>
          <ol className="mt-2 space-y-2">
            {message.sources.map((s, i) => (
              <li key={i}>
                <span className="font-medium text-accent">[{i + 1}] {s.title}</span>
                <blockquote className="mt-0.5 border-l-2 border-border pl-2 text-muted">{s.quote}</blockquote>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
