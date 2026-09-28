# Project: AI portfolio assistant (this site)

The assistant on this website is itself a portfolio project: an AI sales agent. It answers visitors' questions about [Your name]'s work using only the content of this portfolio, with a source for every answer. It can also check availability and book a discovery call, capture and score leads, and email [Your name] when something happens.

## What it demonstrates

- Grounded answers: the model receives the portfolio content as documents with citations enabled, so every claim can be traced to a source.
- Streaming: answers appear word by word, with citations attached as they stream in.
- Cost control: the knowledge base is prompt-cached, so repeat visitors cost a fraction of the first request.
- Tool use: the agent checks a real calendar (Cal.com), books calls only after the visitor confirms, and saves leads with a transparent scoring rubric.
- Notifications: the owner gets an email with the conversation for every booking and every new or upgraded lead.
- API-first: a streaming HTTP API that any website can call, so the same agent can be added to client sites.
- Safety: input and tool validation, per-visitor rate limits, and automatic model fallback if a request is declined.

## Tech stack

TypeScript, Next.js route handlers, the Claude API via the official Anthropic TypeScript SDK (tool use, citations, streaming, prompt caching), Cal.com, Resend, Zod and Vitest.

## Roadmap

1. Database for leads and conversations.
2. Multi-client version that any business can embed with one script tag.
3. Automated evaluations in CI and production tracing.
