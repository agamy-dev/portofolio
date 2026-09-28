import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "./config";
import { getKnowledgeDocs, toDocumentBlocks } from "./knowledge";
import { SYSTEM_PROMPT, sessionContext } from "./prompt";
import { executeTool, toolDefinitions, type ToolDeps } from "./tools";
import type { AgentEvent, ChatTurn, VisitorContext } from "./types";

const MAX_STEPS = 6; // model calls per visitor message
const MAX_JSON_RETRIES = 2;

export type RunAgentOptions = {
  history: ChatTurn[]; // alternating, starting and ending with a user turn
  visitor?: VisitorContext;
  ip?: string;
  deps: ToolDeps;
  onEvent: (event: AgentEvent) => void;
  client?: Anthropic;
  signal?: AbortSignal;
  now?: () => Date;
};

export type RunAgentResult = {
  stopReason: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

let defaultClient: Anthropic | undefined;

/**
 * Runs one visitor turn: streams Claude's answer, executes any tool calls and
 * loops until the model finishes. Framework-independent, so the same agent can
 * sit behind an HTTP route, a CLI or a messaging integration.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const config = getConfig();
  const client = opts.client ?? (defaultClient ??= new Anthropic());
  const now = opts.now ?? (() => new Date());
  const visitor = opts.visitor ?? {};
  const emit = opts.onEvent;

  // Knowledge base first: it's the same for every conversation, so it stays prompt-cached.
  const [first, ...rest] = opts.history;
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        ...toDocumentBlocks(getKnowledgeDocs()),
        { type: "text", text: sessionContext(visitor, now()) },
        { type: "text", text: first.content },
      ],
    },
    ...rest,
  ];

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const tools = toolDefinitions();
  let jsonRetries = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream(
        {
          model: config.model,
          max_tokens: 8000,
          system: SYSTEM_PROMPT,
          tools,
          messages,
          output_config: { effort: config.effort },
          cache_control: { type: "ephemeral" }, // also caches the growing conversation
          // If the model declines, the API retries on Anthropic's recommended fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal: opts.signal },
      );
      for await (const event of stream) forwardStreamEvent(event, emit);
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Tool inputs stream unbuffered, so the SDK can fail to parse one; re-issue that turn.
      if (err instanceof Anthropic.APIError || opts.signal?.aborted || jsonRetries++ >= MAX_JSON_RETRIES) {
        throw err;
      }
      console.warn("[agent] unparseable tool input, retrying turn:", err);
      continue;
    }

    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;

    if (message.stop_reason === "refusal") {
      emit({ type: "error", message: "I can't help with that one. Try asking about projects or services." });
      return { stopReason: "refusal", usage };
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) return { stopReason: message.stop_reason ?? "end_turn", usage };
    if (message.stop_reason === "max_tokens") {
      // A tool input cut off mid-way can still parse; never run it.
      emit({ type: "error", message: "Sorry, that answer got cut off. Please try again." });
      return { stopReason: "max_tokens", usage };
    }

    messages.push({ role: "assistant", content: message.content });
    const ctx = { ip: opts.ip ?? "local", visitor, transcript: opts.history, deps: opts.deps, now };
    const results = await Promise.all(
      toolUses.map(async (block) => {
        const output = await executeTool(block.name, block.input, ctx);
        emit({ type: "tool_result", id: block.id, name: block.name, ok: !output.isError, data: output.data });
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: output.content,
          ...(output.isError ? { is_error: true } : {}),
        };
      }),
    );
    // All results for one assistant turn go back in a single user message.
    messages.push({ role: "user", content: results });
  }

  emit({ type: "error", message: "Sorry, I couldn't finish that. Please try rephrasing." });
  return { stopReason: "max_steps", usage };
}

function forwardStreamEvent(event: Anthropic.Beta.BetaRawMessageStreamEvent, emit: (e: AgentEvent) => void) {
  if (event.type === "content_block_start") {
    if (event.content_block.type === "text") emit({ type: "block" });
    else if (event.content_block.type === "tool_use") {
      emit({ type: "tool_call", id: event.content_block.id, name: event.content_block.name });
    }
  } else if (event.type === "content_block_delta") {
    if (event.delta.type === "text_delta") emit({ type: "text", text: event.delta.text });
    else if (event.delta.type === "citations_delta" && event.delta.citation.type === "char_location") {
      const { document_title, cited_text } = event.delta.citation;
      emit({ type: "citation", title: document_title ?? "Portfolio", quote: cited_text.trim() });
    }
  }
}
