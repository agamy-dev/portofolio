# AI Portfolio Assistant

A portfolio site with a built-in AI assistant. Visitors ask about your work, services and process. It answers only from your own content and shows the source passage behind each answer.

This is step 1 of a bigger project: an embeddable AI sales agent that answers questions, qualifies leads and books meetings.

## How it works

```
content/*.md ──► loaded as citable documents ──► Claude API (streaming, citations on)
                        │                                   │
                prompt-cached prefix               text + citation events
                                                            │
browser ◄── NDJSON stream from /api/chat ◄──────────────────┘
```

- **Grounded answers.** Every Markdown file in `content/` is sent to Claude as a document with [citations](https://platform.claude.com/docs/en/build-with-claude/citations) enabled. The UI shows numbered sources with the exact quoted passage.
- **Prompt caching.** The knowledge base is a stable prefix at the start of every conversation, so it is cached and repeat requests cost much less. Cache hits are logged per request (`[chat] ... cache_read=...`).
- **Streaming.** `/api/chat` streams newline-delimited JSON events (`src/lib/chat-protocol.ts`) that the chat UI renders as they arrive.
- **Guardrails.** Zod input validation, per-IP rate limiting, and server-side model fallback if a request is declined.

For a portfolio-sized knowledge base, sending the whole thing with every request (cached) is more accurate and simpler than vector search. A vector database comes in the multi-client version, where each client's documents are too large to send in full.

## Quick start

```bash
npm install
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

## Make it yours

1. Fill in `content/about.md` and `content/services.md`, replacing every `[bracketed]` placeholder.
2. Add one file per project in `content/projects/`, copying `_template.md`. Files starting with `_` are ignored.
3. Set your name and headline in `src/app/page.tsx`.
4. Optionally tune the assistant's behavior in `src/lib/prompt.ts`.

In development, content changes are picked up without restarting the server.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Create one in the [Claude Console](https://platform.claude.com/settings/keys) |
| `ANTHROPIC_MODEL` | `claude-opus-5` | e.g. `claude-sonnet-5` for lower cost |
| `CHAT_EFFORT` | `low` | `low` / `medium` / `high`: how much the model thinks before answering |

## Deploy

Push to GitHub, import the repo on [Vercel](https://vercel.com/new) and add `ANTHROPIC_API_KEY` as an environment variable. The rate limiter is in memory and applies per server instance. Switch it to Upstash Redis if you need it shared across instances.

## Roadmap

- [x] Chat that answers from portfolio content with citations
- [ ] Tools: book a meeting (Cal.com), score the lead, email a summary
- [ ] Admin dashboard: conversations, leads, unanswered questions
- [ ] Multi-client version with an embeddable `<script>` widget (Supabase + pgvector)
- [ ] Automated evals in CI (promptfoo) and tracing (Langfuse)
