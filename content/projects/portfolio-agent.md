# Project: AI portfolio assistant (this site)

The assistant on this website is itself a portfolio project. It answers visitors' questions about [Your name]'s work using only the content of this portfolio, and every answer links back to the source passage it came from.

## What it demonstrates

- Grounded answers: the model receives the portfolio content as documents with citations enabled, so every claim can be traced to a source.
- Streaming: answers appear word by word, with citations attached as they stream in.
- Cost control: the knowledge base is prompt-cached, so repeat visitors cost a fraction of the first request.
- Safety: input validation, per-visitor rate limiting and automatic model fallback if a request is declined.

## Tech stack

Next.js (App Router), TypeScript, Tailwind CSS and the Claude API via the official Anthropic TypeScript SDK.

## Roadmap

1. Tools: meeting booking, lead scoring and email summaries.
2. Admin dashboard: conversations, leads and unanswered questions.
3. Multi-tenant version that any business can embed with one script tag.
4. Automated evaluations in CI and production tracing.
