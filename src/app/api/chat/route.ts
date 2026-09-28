import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getConfig } from "@/agent/config";
import { LIMITS, rateLimit } from "@/agent/rate-limit";
import { runAgent } from "@/agent/run-agent";
import { createToolDeps } from "@/agent/tools";
import type { AgentEvent } from "@/agent/types";

export const runtime = "nodejs"; // the knowledge base is read from disk

const deps = createToolDeps(getConfig());

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(30)
    .refine(
      (msgs) =>
        msgs.every((m, i) => m.role === (i % 2 === 0 ? "user" : "assistant")) && msgs.length % 2 === 1,
      "Messages must alternate user/assistant, starting and ending with user.",
    ),
  visitor: z
    .object({
      timeZone: z.string().max(64).optional(),
      pageUrl: z.url().max(500).optional(),
    })
    .optional(),
});

/** CORS headers for an allowed cross-origin caller, null if the origin isn't allowed. */
function corsHeaders(request: Request): Record<string, string> | null {
  const origin = request.headers.get("origin");
  if (!origin) return {}; // server-to-server call
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host && URL.parse(origin)?.host === host) return {}; // same origin ("null" origins don't parse)
  const allowed = getConfig().allowedOrigins;
  if (!allowed.includes("*") && !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: Request) {
  const cors = corsHeaders(request);
  return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
}

export async function POST(request: Request) {
  const cors = corsHeaders(request);
  if (!cors) return Response.json({ error: "Origin not allowed." }, { status: 403 });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limit = rateLimit(`chat:${ip}`, LIMITS.chat);
  if (!limit.ok) {
    return Response.json(
      { error: "Too many messages. Please try again in a few minutes." },
      { status: 429, headers: { ...cors, "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400, headers: cors });
  }
  const { messages: history, visitor } = parsed.data;
  const run = (onEvent: (e: AgentEvent) => void) =>
    runAgent({ history, visitor, ip, deps, onEvent, signal: request.signal }).then((result) => {
      const u = result.usage;
      console.log(
        `[chat] in=${u.input} cache_read=${u.cacheRead} cache_write=${u.cacheWrite} out=${u.output} stop=${result.stopReason}`,
      );
      return result;
    });

  // JSON mode (?stream=false) for integrations that can't consume a stream.
  if (new URL(request.url).searchParams.get("stream") === "false") {
    const events: AgentEvent[] = [];
    try {
      const result = await run((e) => events.push(e));
      return Response.json(summarize(events, result.stopReason), { headers: cors });
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 502, headers: cors });
    }
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AgentEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        await run(send);
        send({ type: "done" });
      } catch (error) {
        if (!request.signal.aborted) send({ type: "error", message: errorMessage(error) });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed because the client disconnected
        }
      }
    },
  });

  return new Response(body, {
    headers: { ...cors, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function summarize(events: AgentEvent[], stopReason: string) {
  const citations: { title: string; quote: string }[] = [];
  const toolResults: { name: string; ok: boolean; data?: unknown }[] = [];
  let reply = "";
  let afterTool = false;
  const errors: string[] = [];
  for (const e of events) {
    if (e.type === "tool_call") afterTool = true;
    else if (e.type === "text") {
      // Text before and after a tool call are separate paragraphs.
      if (afterTool && reply && !/\s$/.test(reply)) reply += "\n\n";
      afterTool = false;
      reply += e.text;
    } else if (e.type === "citation" && !citations.some((c) => c.title === e.title && c.quote === e.quote)) {
      citations.push({ title: e.title, quote: e.quote });
    } else if (e.type === "tool_result") toolResults.push({ name: e.name, ok: e.ok, data: e.data });
    else if (e.type === "error") errors.push(e.message);
  }
  return { reply, citations, toolResults, stopReason, ...(errors.length ? { error: errors.join(" ") } : {}) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return "The assistant is busy right now. Please try again shortly.";
  console.error("[chat] error:", error);
  return "Something went wrong. Please try again.";
}
