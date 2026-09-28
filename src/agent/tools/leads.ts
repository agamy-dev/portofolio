import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const SERVICES = ["ai_assistant", "ai_agent_or_automation", "web_development", "ongoing_support", "other"] as const;
export const BUDGETS = ["unknown", "under_1k", "1k_to_5k", "5k_to_20k", "over_20k"] as const;
export const TIMELINES = ["unknown", "asap", "within_3_months", "3_to_6_months", "later"] as const;

export const leadInputSchema = z.object({
  email: z.email().describe("Visitor's email address, exactly as they gave it."),
  name: z.string().max(120).optional().describe("Visitor's name, if given."),
  company: z.string().max(120).optional().describe("Company or organisation, if given."),
  need: z
    .string()
    .min(1)
    .max(1000)
    .describe("One or two sentences on what the visitor wants built and why, in your words."),
  service: z.enum(SERVICES).describe("Closest matching service."),
  budget: z.enum(BUDGETS).describe("Budget in USD if the visitor stated one, otherwise unknown. Never guess."),
  timeline: z.enum(TIMELINES).describe("When they want to start, if stated, otherwise unknown."),
});

export type LeadInput = z.infer<typeof leadInputSchema>;
export type LeadTier = "hot" | "warm" | "cold";
export type Lead = LeadInput & { score: number; tier: LeadTier; createdAt: string; updatedAt: string };

const BUDGET_POINTS: Record<LeadInput["budget"], number> = {
  unknown: 5,
  under_1k: 0,
  "1k_to_5k": 15,
  "5k_to_20k": 30,
  over_20k: 40,
};
const TIMELINE_POINTS: Record<LeadInput["timeline"], number> = {
  unknown: 5,
  asap: 25,
  within_3_months: 20,
  "3_to_6_months": 10,
  later: 0,
};

/**
 * Transparent, rule-based score out of 100: budget (40) + timeline (25) +
 * service fit (20) + contact details (15). Easy to explain to a client and to tune.
 */
export function scoreLead(lead: LeadInput): { score: number; tier: LeadTier } {
  const score =
    BUDGET_POINTS[lead.budget] +
    TIMELINE_POINTS[lead.timeline] +
    (lead.service === "other" ? 5 : 20) +
    10 + // an email address is required, so it's always present
    (lead.name ? 3 : 0) +
    (lead.company ? 2 : 0);
  return { score, tier: score >= 70 ? "hot" : score >= 40 ? "warm" : "cold" };
}

export interface LeadStore {
  /** Inserts or updates the lead with the same email; returns the previous version if there was one. */
  upsert(lead: Lead): Promise<{ previous?: Lead }>;
}

/** JSON file store for local development. Use a database in production (serverless file systems are read-only). */
export class FileLeadStore implements LeadStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  upsert(lead: Lead): Promise<{ previous?: Lead }> {
    // Serialise writes so concurrent requests don't clobber each other.
    const run = this.queue.then(async () => {
      const leads = await this.readAll();
      const index = leads.findIndex((l) => l.email.toLowerCase() === lead.email.toLowerCase());
      const previous = index >= 0 ? leads[index] : undefined;
      const merged = previous ? { ...previous, ...stripUndefined(lead), createdAt: previous.createdAt } : lead;
      if (index >= 0) leads[index] = merged;
      else leads.push(merged);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(leads, null, 2));
      return { previous };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async readAll(): Promise<Lead[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
