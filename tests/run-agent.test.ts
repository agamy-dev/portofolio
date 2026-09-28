import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/run-agent";
import type { AgentEvent } from "../src/agent/types";
import { makeContext, NOW } from "./helpers";

type Block = Anthropic.Beta.BetaContentBlock;
type Turn = { content: Block[]; stop_reason: Anthropic.Beta.BetaStopReason; citation?: Anthropic.Beta.BetaTextCitation };

/** Scripted stand-in for the Anthropic client: each call to stream() plays the next turn. */
function fakeClient(turns: Turn[]) {
  const requests: Anthropic.Beta.MessageCreateParams[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Anthropic.Beta.MessageCreateParams) {
          requests.push(structuredClone(params));
          const turn = turns[requests.length - 1];
          if (!turn) throw new Error("unexpected extra model call");
          const events: Anthropic.Beta.BetaRawMessageStreamEvent[] = [];
          turn.content.forEach((block, index) => {
            if (block.type === "text") {
              events.push({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } });
              if (turn.citation) events.push({ type: "content_block_delta", index, delta: { type: "citations_delta", citation: turn.citation } });
              events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
            } else if (block.type === "tool_use") {
              events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
            }
          });
          const message = {
            content: turn.content,
            stop_reason: turn.stop_reason,
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
          } as unknown as Anthropic.Beta.BetaMessage;
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown): Block =>
  ({ type: "tool_use", id, name, input, caller: { type: "direct" } }) as unknown as Block;

describe("runAgent", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
  });

  it("answers from the knowledge base and forwards citations", async () => {
    const { ctx } = makeContext();
    const { client, requests } = fakeClient([
      {
        content: [text("I build AI assistants.")],
        stop_reason: "end_turn",
        citation: {
          type: "char_location",
          cited_text: "A chat assistant ",
          document_index: 0,
          document_title: "Services",
          start_char_index: 0,
          end_char_index: 17,
          file_id: null,
        },
      },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent({
      history: [{ role: "user", content: "What do you build?" }],
      visitor: { timeZone: "Europe/London" },
      deps: ctx.deps,
      client,
      now: () => NOW,
      onEvent: (e) => events.push(e),
    });

    expect(result.stopReason).toBe("end_turn");
    expect(events).toContainEqual({ type: "citation", title: "Services", quote: "A chat assistant" });
    expect(events).toContainEqual({ type: "text", text: "I build AI assistants." });

    const req = requests[0];
    expect(req.model).toBe("claude-opus-5");
    expect(req.tools?.map((t) => ("name" in t ? t.name : t.type))).toEqual(["check_availability", "book_meeting", "save_lead"]);
    const first = req.messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    const docs = first.filter((b) => b.type === "document");
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.at(-1)).toHaveProperty("cache_control");
    expect(first.at(-2)).toMatchObject({ type: "text", text: expect.stringContaining("2030-01-07") });
    expect(first.at(-1)).toEqual({ type: "text", text: "What do you build?" });
  });

  it("runs tool calls and sends every result back in one message", async () => {
    const { ctx } = makeContext();
    const { client, requests } = fakeClient([
      {
        content: [
          text("Let me check."),
          toolUse("t1", "check_availability", { from_date: "2030-01-07", to_date: "2030-01-08", time_zone: "UTC" }),
          toolUse("t2", "book_meeting", { start: "bad", name: "Sam", email: "sam@example.com", time_zone: "UTC" }),
        ],
        stop_reason: "tool_use",
      },
      { content: [text("Here are some times.")], stop_reason: "end_turn" },
    ]);
    const events: AgentEvent[] = [];
    await runAgent({
      history: [{ role: "user", content: "Can we talk this week?" }],
      deps: ctx.deps,
      client,
      now: () => NOW,
      onEvent: (e) => events.push(e),
    });

    expect(requests).toHaveLength(2);
    const followUp = requests[1].messages;
    expect(followUp.at(-2)?.role).toBe("assistant");
    const results = followUp.at(-1)?.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([
      ["t1", false],
      ["t2", true],
    ]);
    expect(events.filter((e) => e.type === "tool_call").map((e) => e.type === "tool_call" && e.name)).toEqual([
      "check_availability",
      "book_meeting",
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", name: "book_meeting", ok: false }));
  });

  it("never runs tools from a turn that was cut off", async () => {
    const { ctx, notifier } = makeContext();
    const { client, requests } = fakeClient([
      {
        content: [toolUse("t1", "save_lead", { email: "sam@example.com", need: "x", service: "other", budget: "unknown", timeline: "unknown" })],
        stop_reason: "max_tokens",
      },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent({
      history: [{ role: "user", content: "hi" }],
      deps: ctx.deps,
      client,
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("max_tokens");
    expect(requests).toHaveLength(1);
    expect(notifier.sent).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("reports refusals as an error event", async () => {
    const { ctx } = makeContext();
    const { client } = fakeClient([{ content: [], stop_reason: "refusal" }]);
    const events: AgentEvent[] = [];
    const result = await runAgent({
      history: [{ role: "user", content: "hi" }],
      deps: ctx.deps,
      client,
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("refusal");
    expect(events).toEqual([expect.objectContaining({ type: "error" })]);
  });
});
