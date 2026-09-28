import type { Notifier } from "../src/agent/tools/notify";
import type { Lead, LeadStore } from "../src/agent/tools/leads";
import { DemoCalendar } from "../src/agent/tools/calendar";
import type { ToolContext } from "../src/agent/tools";

// Monday 2030-01-07, 08:00 UTC
export const NOW = new Date("2030-01-07T08:00:00Z");

export class MemoryLeadStore implements LeadStore {
  leads: Lead[] = [];
  async upsert(lead: Lead) {
    const i = this.leads.findIndex((l) => l.email === lead.email);
    const previous = i >= 0 ? this.leads[i] : undefined;
    if (i >= 0) this.leads[i] = lead;
    else this.leads.push(lead);
    return { previous };
  }
}

export class MemoryNotifier implements Notifier {
  sent: { subject: string; text: string }[] = [];
  async send(message: { subject: string; text: string }) {
    this.sent.push(message);
  }
}

let ipCounter = 0;

export function makeContext(overrides: Partial<ToolContext> = {}) {
  const leads = new MemoryLeadStore();
  const notifier = new MemoryNotifier();
  const ctx: ToolContext = {
    ip: `test-${++ipCounter}`, // fresh rate-limit bucket per test
    visitor: { timeZone: "Europe/London" },
    transcript: [{ role: "user", content: "I need an AI assistant for my shop." }],
    deps: { calendar: new DemoCalendar(() => NOW), leads, notifier },
    now: () => NOW,
    ...overrides,
  };
  return { ctx, leads, notifier };
}
