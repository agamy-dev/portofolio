import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentConfig } from "../config";
import { LIMITS, rateLimit } from "../rate-limit";
import type { ChatTurn, VisitorContext } from "../types";
import { CalComCalendar, CalendarError, DemoCalendar, type CalendarProvider } from "./calendar";
import { FileLeadStore, leadInputSchema, scoreLead, type LeadStore } from "./leads";
import { ConsoleNotifier, ResendNotifier, type Notifier } from "./notify";

export type ToolDeps = { calendar: CalendarProvider; leads: LeadStore; notifier: Notifier };

export type ToolContext = {
  ip: string;
  visitor: VisitorContext;
  /** Visible conversation so far, included in owner notifications. */
  transcript: ChatTurn[];
  deps: ToolDeps;
  now: () => Date;
};

/** `content` goes back to the model; `data` is streamed to the client in a tool_result event. */
export type ToolOutput = { content: string; data?: unknown; isError?: boolean };

type AgentTool<S extends z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
};

const defineTool = <S extends z.ZodType>(tool: AgentTool<S>) => tool;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const timeZone = z
  .string()
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown IANA time zone")
  .describe('IANA time zone, e.g. "Europe/London".');

const checkAvailability = defineTool({
  name: "check_availability",
  description:
    "List open slots for a 30-minute discovery call between two dates (inclusive, at most 14 days apart). " +
    "Call this before offering times; only ever offer times it returns.",
  schema: z.object({
    from_date: isoDate.describe("First day to search, YYYY-MM-DD."),
    to_date: isoDate.describe("Last day to search, YYYY-MM-DD."),
    time_zone: timeZone.describe("Visitor's IANA time zone, used to label the slots."),
  }),
  async run({ from_date, to_date, time_zone }, { deps, now }) {
    const from = new Date(`${from_date}T00:00:00Z`);
    const to = new Date(`${to_date}T00:00:00Z`);
    const today = new Date(now().toISOString().slice(0, 10) + "T00:00:00Z");
    if (to < from) return { content: "to_date is before from_date.", isError: true };
    if (to.getTime() - from.getTime() > 14 * 86_400_000) {
      return { content: "Search at most 14 days at a time.", isError: true };
    }
    if (to < today) return { content: "Those dates are in the past.", isError: true };
    const slots = await deps.calendar.getSlots({ fromDate: from_date, toDate: to_date, timeZone: time_zone });
    if (slots.length === 0) {
      return { content: "No open slots in that range. Try later dates.", data: { slots } };
    }
    return {
      content: JSON.stringify({ slots, note: "Offer a few of these using the labels; book with the exact start value." }),
      data: { slots },
    };
  },
});

const bookMeeting = defineTool({
  name: "book_meeting",
  description:
    "Book a discovery call in one of the slots returned by check_availability. Only call this after the " +
    "visitor has explicitly confirmed the time, their name and their email address.",
  schema: z.object({
    start: z.iso.datetime({ offset: true }).describe("Exact `start` value of the chosen slot."),
    name: z.string().min(1).max(120).describe("Visitor's name."),
    email: z.email().describe("Visitor's email address; the invite is sent here."),
    time_zone: timeZone,
    notes: z.string().max(500).optional().describe("Short summary of what they want to discuss."),
  }),
  async run(input, { ip, deps, transcript }) {
    if (!rateLimit(`book:${ip}`, LIMITS.booking).ok) {
      return { content: "Booking limit reached for today. Ask the visitor to email instead.", isError: true };
    }
    const booking = await deps.calendar.book({
      start: input.start,
      name: input.name,
      email: input.email,
      timeZone: input.time_zone,
      notes: input.notes,
    });
    await notifySafely(deps.notifier, {
      subject: `New call booked: ${input.name} (${new Date(booking.start).toUTCString()})`,
      text: [
        `${input.name} <${input.email}> booked a call for ${new Date(booking.start).toUTCString()} (their time zone: ${input.time_zone}).`,
        input.notes ? `Notes: ${input.notes}` : "",
        deps.calendar.mode === "demo" ? "(Demo calendar: nothing was added to a real calendar.)" : "",
        "",
        formatTranscript(transcript),
      ]
        .filter((line) => line !== "")
        .join("\n"),
    });
    const data = { ...booking, demo: deps.calendar.mode === "demo" };
    return { content: JSON.stringify({ booked: true, ...data }), data };
  },
});

const saveLead = defineTool({
  name: "save_lead",
  description:
    "Save the visitor as a lead so the engineer can follow up. Call it once the visitor has shared their email " +
    "and is happy to be contacted, and again if you learn more (budget, timeline) later. Don't ask for " +
    "details just to fill this in.",
  schema: leadInputSchema,
  async run(input, { ip, deps, transcript, now }) {
    if (!rateLimit(`lead:${ip}`, LIMITS.lead).ok) {
      return { content: "Lead limit reached. Don't retry.", isError: true };
    }
    const { score, tier } = scoreLead(input);
    const timestamp = now().toISOString();
    const lead = { ...input, score, tier, createdAt: timestamp, updatedAt: timestamp };

    let previousTier: string | undefined;
    try {
      previousTier = (await deps.leads.upsert(lead)).previous?.tier;
    } catch (err) {
      // The owner email below is still a record of the lead.
      console.error("[save_lead] could not store lead:", err);
    }

    const rank = { cold: 0, warm: 1, hot: 2 } as const;
    if (!previousTier || rank[tier] > rank[previousTier as keyof typeof rank]) {
      await notifySafely(deps.notifier, {
        subject: `${tier.toUpperCase()} lead (${score}/100): ${input.name ?? input.email}`,
        text: [
          `Name: ${input.name ?? "-"}`,
          `Email: ${input.email}`,
          `Company: ${input.company ?? "-"}`,
          `Service: ${input.service}`,
          `Budget: ${input.budget}`,
          `Timeline: ${input.timeline}`,
          `Need: ${input.need}`,
          "",
          formatTranscript(transcript),
        ].join("\n"),
      });
    }
    // The score is internal: the client only learns that the lead was saved.
    return {
      content: `Lead saved (priority: ${tier}). Don't mention scores or priority to the visitor.`,
      data: { saved: true },
    };
  },
});

export const TOOLS = [checkAvailability, bookMeeting, saveLead];

/** Tool definitions in the shape the Messages API expects. */
export function toolDefinitions(): Anthropic.Beta.BetaTool[] {
  return TOOLS.map((tool) => {
    const schema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    };
  });
}

/**
 * Validates and runs one tool call. Never throws: failures become error results
 * the model can react to.
 */
export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return { content: `Invalid input: ${z.prettifyError(parsed.error)}`, isError: true };
  }
  try {
    // Each entry's run() accepts its own schema's output, which is what parsed.data is.
    return await (tool.run as (i: unknown, c: ToolContext) => Promise<ToolOutput>)(parsed.data, ctx);
  } catch (err) {
    if (err instanceof CalendarError) return { content: err.message, isError: true };
    console.error(`[tool ${name}]`, err);
    return { content: "The tool failed unexpectedly. Apologise and offer email contact instead.", isError: true };
  }
}

export function createToolDeps(config: AgentConfig): ToolDeps {
  return {
    calendar: config.calcom ? new CalComCalendar(config.calcom) : new DemoCalendar(),
    leads: new FileLeadStore(config.leadsFile),
    notifier:
      config.resend && config.ownerEmail
        ? new ResendNotifier({ ...config.resend, to: config.ownerEmail })
        : new ConsoleNotifier(),
  };
}

async function notifySafely(notifier: Notifier, message: { subject: string; text: string }) {
  try {
    await notifier.send(message);
  } catch (err) {
    console.error("[notify] failed:", err);
  }
}

function formatTranscript(transcript: ChatTurn[]): string {
  return ["Conversation:", ...transcript.map((t) => `${t.role === "user" ? "Visitor" : "Assistant"}: ${t.content}`)].join(
    "\n",
  );
}
