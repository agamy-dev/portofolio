import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ChatEvent } from "@/lib/chat-protocol";
import { getKnowledgeDocs, toDocumentBlocks } from "@/lib/knowledge";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs"; // the knowledge base is read from disk

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
const EFFORT = z.enum(["low", "medium", "high"]).catch("low").parse(process.env.CHAT_EFFORT);

const client = new Anthropic();

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
        msgs.every((m, i) => m.role === (i % 2 === 0 ? "user" : "assistant")) &&
        msgs.length % 2 === 1,
      "Messages must alternate user/assistant, starting and ending with user.",
    ),
});

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limit = rateLimit(ip);
  if (!limit.ok) {
    return Response.json(
      { error: "Too many messages. Please try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  // The knowledge base goes at the start of the first user turn, so it is a
  // stable prefix shared by every conversation and gets prompt-cached.
  const [first, ...rest] = parsed.data.messages;
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [...toDocumentBlocks(getKnowledgeDocs()), { type: "text", text: first.content }],
    },
    ...rest,
  ];

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      try {
        const stream = client.beta.messages.stream(
          {
            model: MODEL,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages,
            output_config: { effort: EFFORT },
            // Also caches the growing conversation, not just the knowledge base.
            cache_control: { type: "ephemeral" },
            // If the model declines, the API retries on Anthropic's recommended fallback model.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          },
          { signal: request.signal },
        );

        for await (const event of stream) {
          if (event.type === "content_block_start" && event.content_block.type === "text") {
            send({ type: "block" });
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              send({ type: "text", text: event.delta.text });
            } else if (
              event.delta.type === "citations_delta" &&
              event.delta.citation.type === "char_location"
            ) {
              const { document_title, cited_text } = event.delta.citation;
              send({ type: "citation", title: document_title ?? "Portfolio", quote: cited_text.trim() });
            }
          }
        }

        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          send({ type: "error", message: "I can't help with that one. Try asking about projects or services." });
        }
        const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens } =
          final.usage;
        console.log(
          `[chat] ${final.model} in=${input_tokens} cache_read=${cache_read_input_tokens} ` +
            `cache_write=${cache_creation_input_tokens} out=${output_tokens} stop=${final.stop_reason}`,
        );
        send({ type: "done" });
      } catch (error) {
        if (request.signal.aborted) return; // visitor closed the page
        if (error instanceof Anthropic.RateLimitError) {
          send({ type: "error", message: "The assistant is busy right now. Please try again shortly." });
        } else if (error instanceof Anthropic.APIError) {
          console.error(`[chat] API error ${error.status}:`, error.message);
          send({ type: "error", message: "Something went wrong. Please try again." });
        } else {
          console.error("[chat] unexpected error:", error);
          send({ type: "error", message: "Something went wrong. Please try again." });
        }
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
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
