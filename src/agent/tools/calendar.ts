export type Slot = { start: string; label: string };
export type Booking = { uid: string; start: string; meetingUrl?: string };
export type BookingRequest = { start: string; name: string; email: string; timeZone: string; notes?: string };

export interface CalendarProvider {
  readonly mode: "calcom" | "demo";
  /** Open slots between two dates (YYYY-MM-DD, inclusive), labelled in `timeZone`. */
  getSlots(args: { fromDate: string; toDate: string; timeZone: string }): Promise<Slot[]>;
  book(req: BookingRequest): Promise<Booking>;
}

export class CalendarError extends Error {}

const MAX_SLOTS = 24;

export function formatSlot(startIso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(startIso));
}

/** Cal.com API v2: https://cal.com/docs/api-reference/v2 */
export class CalComCalendar implements CalendarProvider {
  readonly mode = "calcom";

  constructor(
    private readonly opts: { apiKey: string; eventTypeId: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit & { apiVersion: string }) {
    const res = await this.fetchImpl(`https://api.cal.com/v2${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "cal-api-version": init.apiVersion,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== "success") {
      const detail = body?.error?.message ?? body?.message ?? res.statusText;
      throw new CalendarError(`Cal.com ${res.status}: ${detail}`);
    }
    return body.data;
  }

  async getSlots({ fromDate, toDate, timeZone }: { fromDate: string; toDate: string; timeZone: string }) {
    const params = new URLSearchParams({
      eventTypeId: String(this.opts.eventTypeId),
      start: fromDate,
      end: toDate,
      timeZone,
    });
    const data: Record<string, { start: string }[]> = await this.request(`/slots?${params}`, {
      method: "GET",
      apiVersion: "2024-09-04",
    });
    return Object.values(data)
      .flat()
      .slice(0, MAX_SLOTS)
      .map(({ start }) => ({ start, label: formatSlot(start, timeZone) }));
  }

  async book(req: BookingRequest): Promise<Booking> {
    const data = await this.request("/bookings", {
      method: "POST",
      apiVersion: "2026-02-25",
      body: JSON.stringify({
        eventTypeId: this.opts.eventTypeId,
        start: new Date(req.start).toISOString(),
        attendee: { name: req.name, email: req.email, timeZone: req.timeZone },
        ...(req.notes ? { bookingFieldsResponses: { notes: req.notes } } : {}),
        metadata: { source: "portfolio-agent" },
      }),
    });
    const location = typeof data.location === "string" && /^https?:\/\//.test(data.location) ? data.location : undefined;
    return { uid: String(data.uid), start: data.start, meetingUrl: location };
  }
}

/**
 * Stand-in used when Cal.com isn't configured: weekday slots 09:00-16:00 UTC, and
 * bookings that are only logged. Lets the whole flow run locally without accounts.
 */
export class DemoCalendar implements CalendarProvider {
  readonly mode = "demo";

  constructor(private readonly now: () => Date = () => new Date()) {}

  async getSlots({ fromDate, toDate, timeZone }: { fromDate: string; toDate: string; timeZone: string }) {
    const earliest = this.now().getTime() + 60 * 60 * 1000;
    const slots: Slot[] = [];
    for (let day = new Date(`${fromDate}T00:00:00Z`); day <= new Date(`${toDate}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      for (let hour = 9; hour <= 16; hour++) {
        const start = new Date(day);
        start.setUTCHours(hour);
        if (start.getTime() < earliest) continue;
        const iso = start.toISOString();
        slots.push({ start: iso, label: formatSlot(iso, timeZone) });
      }
    }
    return slots.slice(0, MAX_SLOTS);
  }

  async book(req: BookingRequest): Promise<Booking> {
    const start = new Date(req.start);
    const hour = start.getUTCHours();
    if (start.getUTCMinutes() !== 0 || hour < 9 || hour > 16 || [0, 6].includes(start.getUTCDay())) {
      throw new CalendarError("That time is not an available slot.");
    }
    if (start.getTime() < this.now().getTime()) throw new CalendarError("That time is in the past.");
    return { uid: `demo-${start.getTime().toString(36)}`, start: start.toISOString() };
  }
}
