import { describe, expect, it } from "vitest";
import { CalComCalendar, CalendarError, DemoCalendar } from "../src/agent/tools/calendar";
import { NOW } from "./helpers";

describe("DemoCalendar", () => {
  const cal = new DemoCalendar(() => NOW);

  it("offers weekday slots from an hour from now, skipping weekends", async () => {
    const slots = await cal.getSlots({ fromDate: "2030-01-07", toDate: "2030-01-13", timeZone: "UTC" });
    expect(slots[0].start).toBe("2030-01-07T09:00:00.000Z");
    expect(slots.every((s) => ![0, 6].includes(new Date(s.start).getUTCDay()))).toBe(true);
    expect(slots.length).toBe(24); // capped
  });

  it("labels slots in the visitor's time zone", async () => {
    const [slot] = await cal.getSlots({ fromDate: "2030-01-07", toDate: "2030-01-07", timeZone: "America/New_York" });
    expect(slot.label).toContain("4:00 AM");
  });

  it("rejects times that aren't open slots", async () => {
    const req = { name: "Sam", email: "sam@example.com", timeZone: "UTC" };
    await expect(cal.book({ ...req, start: "2030-01-12T10:00:00Z" })).rejects.toThrow(CalendarError); // Saturday
    await expect(cal.book({ ...req, start: "2030-01-07T20:00:00Z" })).rejects.toThrow(CalendarError);
    await expect(cal.book({ ...req, start: "2030-01-07T10:00:00Z" })).resolves.toMatchObject({
      start: "2030-01-07T10:00:00.000Z",
    });
  });
});

describe("CalComCalendar", () => {
  function fakeFetch(response: { status: number; body: unknown }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(response.body), { status: response.status });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it("requests slots for the event type and flattens the per-day map", async () => {
    const { calls, impl } = fakeFetch({
      status: 200,
      body: {
        status: "success",
        data: { "2030-01-07": [{ start: "2030-01-07T09:00:00.000+00:00" }], "2030-01-08": [{ start: "2030-01-08T09:00:00.000+00:00" }] },
      },
    });
    const cal = new CalComCalendar({ apiKey: "key", eventTypeId: 42 }, impl);
    const slots = await cal.getSlots({ fromDate: "2030-01-07", toDate: "2030-01-08", timeZone: "UTC" });

    expect(slots.map((s) => s.start)).toEqual(["2030-01-07T09:00:00.000+00:00", "2030-01-08T09:00:00.000+00:00"]);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v2/slots");
    expect(url.searchParams.get("eventTypeId")).toBe("42");
    expect((calls[0].init.headers as Record<string, string>)["cal-api-version"]).toBe("2024-09-04");
  });

  it("creates a booking and returns the meeting link", async () => {
    const { calls, impl } = fakeFetch({
      status: 201,
      body: { status: "success", data: { uid: "abc", start: "2030-01-07T09:00:00Z", location: "https://meet.example/abc" } },
    });
    const cal = new CalComCalendar({ apiKey: "key", eventTypeId: 42 }, impl);
    const booking = await cal.book({ start: "2030-01-07T09:00:00Z", name: "Sam", email: "sam@example.com", timeZone: "UTC" });

    expect(booking).toEqual({ uid: "abc", start: "2030-01-07T09:00:00Z", meetingUrl: "https://meet.example/abc" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({ eventTypeId: 42, attendee: { name: "Sam", email: "sam@example.com", timeZone: "UTC" } });
  });

  it("turns API errors into CalendarError", async () => {
    const { impl } = fakeFetch({ status: 400, body: { status: "error", error: { message: "Slot taken" } } });
    const cal = new CalComCalendar({ apiKey: "key", eventTypeId: 42 }, impl);
    await expect(
      cal.book({ start: "2030-01-07T09:00:00Z", name: "Sam", email: "sam@example.com", timeZone: "UTC" }),
    ).rejects.toThrow("Slot taken");
  });
});
