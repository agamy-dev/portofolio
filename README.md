# AI Portfolio Agent

An AI sales agent for a freelancer's website. It answers visitors' questions from your own content (with sources), books discovery calls on your calendar, captures and scores leads, and emails you when something happens.

It's built API-first, so any website can use it: your portfolio, a client's WordPress site, a Webflow page, or later a WhatsApp integration.

## What the agent can do

| Capability | How |
|---|---|
| Answer questions with sources | Everything in `content/` is sent to Claude as citable documents. Every answer can point to the passage it came from. |
| Check availability | `check_availability` tool: open slots from Cal.com, labelled in the visitor's time zone |
| Book a call | `book_meeting` tool: books on Cal.com after the visitor confirms the time, name and email |
| Capture leads | `save_lead` tool: records the visitor's need, budget and timeline and scores the lead (hot / warm / cold) |
| Notify you | An email via Resend for every booking and every new or upgraded lead, with the conversation attached |

Without Cal.com or Resend keys, a **demo calendar** and **console notifications** are used, so the whole flow works locally with only a Claude API key.

## Quick start

```bash
npm install
cp .env.example .env.local   # add ANTHROPIC_API_KEY (everything else is optional)
npm run chat                 # talk to the agent in your terminal
npm run dev                  # or run the HTTP API on http://localhost:3000
```

The terminal client shows tool calls, sources and token usage (including cache hits) for each turn.

## HTTP API

### `POST /api/chat`

```json
{
  "messages": [
    { "role": "user", "content": "Can you build an assistant for my online shop?" }
  ],
  "visitor": { "timeZone": "Europe/London", "pageUrl": "https://example.com/services" }
}
```

- `messages`: the visible conversation, alternating `user` / `assistant`, starting and ending with `user` (max 30 turns, 2,000 characters each). The API is stateless: send the whole conversation each time.
- `visitor` (optional): the browser's time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and the current page.

**Streaming response (default):** newline-delimited JSON events:

| Event | Meaning |
|---|---|
| `{"type":"block"}` | A new text block starts. Citations that follow belong to it. |
| `{"type":"text","text":"…"}` | Answer text, streamed |
| `{"type":"citation","title":"Services","quote":"…"}` | Source for the current block |
| `{"type":"tool_call","id":"…","name":"check_availability"}` | The agent started a tool call |
| `{"type":"tool_result","id":"…","name":"…","ok":true,"data":{…}}` | Tool finished. `data` has `slots` or the booking (`start`, `meetingUrl`) for rendering. |
| `{"type":"error","message":"…"}` | A message you can show to the visitor |
| `{"type":"done"}` | End of the turn |

Ignore event types you don't recognise, because new ones may be added.

**JSON response (`POST /api/chat?stream=false`):** for integrations that can't read a stream:

```json
{ "reply": "…", "citations": [{ "title": "…", "quote": "…" }], "toolResults": [{ "name": "…", "ok": true, "data": {} }], "stopReason": "end_turn" }
```

**Calling from another website:** add its origin to `ALLOWED_ORIGINS`. Requests from other browser origins get `403`. Server-to-server calls (no `Origin` header) are always allowed.

```js
const res = await fetch("https://your-agent.vercel.app/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages, visitor: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } }),
});
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
// split on "\n" and JSON.parse each line
```

## Project layout

```
content/              knowledge base (Markdown; files starting with "_" are ignored)
src/agent/            the agent, independent of Next.js
  run-agent.ts        streaming tool-use loop
  prompt.ts           system prompt
  knowledge.ts        loads content/ as cached, citable documents
  tools/              check_availability, book_meeting, save_lead
    calendar.ts       Cal.com client and the demo calendar
    leads.ts          lead schema, scoring rubric and file store
    notify.ts         Resend and console notifiers
src/app/api/chat/     HTTP adapter: validation, rate limits, CORS, streaming/JSON
scripts/chat.mts      terminal client
tests/                unit tests (npm test)
```

## Configuration

See `.env.example` for all settings. The main ones:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required |
| `ANTHROPIC_MODEL` | Defaults to `claude-opus-5`; `claude-sonnet-5` costs less |
| `CALCOM_API_KEY`, `CALCOM_EVENT_TYPE_ID` | Real bookings (Cal.com → Settings → Developer → API keys; the event type ID is in the event's URL) |
| `RESEND_API_KEY`, `OWNER_EMAIL`, `NOTIFY_FROM_EMAIL` | Email notifications (the sender must be on a domain verified in Resend) |
| `ALLOWED_ORIGINS` | Websites allowed to embed the agent |

## Safety and cost controls

- Input validated with Zod; every tool input is validated before it runs, and failures go back to the model as error results.
- Per-IP limits: 20 messages per 10 minutes, 3 bookings per day, 10 lead saves per hour. These are in memory; use Redis if you run several server instances.
- Tools never run from a response that was cut off. The loop is capped at 6 model calls per message.
- Lead scores are never sent to the browser.
- The knowledge base and conversation are prompt-cached. The server log shows `cache_read` for each request.
- If the model declines a request, the API retries on Anthropic's recommended fallback model (`fallbacks: "default"`).

## Lead scoring

Rule-based and easy to explain to a client (`src/agent/tools/leads.ts`): budget (up to 40 points) + timeline (25) + service fit (20) + contact details (15). A score of 70 or more is **hot**, 40 or more is **warm**, otherwise **cold**. You get an email for a new lead, and again only if its tier goes up.

## Development

```bash
npm test            # unit tests: scoring, calendars, tools, agent loop (Claude is mocked)
npm run typecheck
npm run lint
```

`src/app/page.tsx` is a minimal test page and isn't part of the product.

## Roadmap

- [x] Answers with sources from portfolio content
- [x] Tools: availability, booking, lead capture, owner notifications
- [ ] Database for leads and conversations (Supabase), replacing the local file store
- [ ] Multi-client: per-client knowledge base, tools config and API keys
- [ ] Embeddable `<script>` widget
- [ ] Automated evals in CI (promptfoo) and tracing (Langfuse)
