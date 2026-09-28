import { describe, expect, it } from "vitest";
import { executeTool, toolDefinitions } from "../src/agent/tools";
import { makeContext } from "./helpers";

describe("toolDefinitions", () => {
  it("exposes the three tools with plain JSON schemas", () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(["check_availability", "book_meeting", "save_lead"]);
    for (const def of defs) {
      expect(def.input_schema.type).toBe("object");
      expect(def.input_schema).not.toHaveProperty("$schema");
    }
  });
});

describe("executeTool", () => {
  it("rejects unknown tools and invalid input without throwing", async () => {
    const { ctx } = makeContext();
    expect(await executeTool("nope", {}, ctx)).toMatchObject({ isError: true });
    const bad = await executeTool("book_meeting", { start: "tomorrow", name: "Sam", email: "x", time_zone: "UTC" }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("Invalid input");
  });

  it("check_availability limits the search window", async () => {
    const { ctx } = makeContext();
    const res = await executeTool(
      "check_availability",
      { from_date: "2030-01-07", to_date: "2030-02-07", time_zone: "UTC" },
      ctx,
    );
    expect(res).toMatchObject({ isError: true, content: expect.stringContaining("14 days") });
  });

  it("check_availability returns slots to the model and the client", async () => {
    const { ctx } = makeContext();
    const res = await executeTool(
      "check_availability",
      { from_date: "2030-01-07", to_date: "2030-01-08", time_zone: "Europe/London" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect((res.data as { slots: unknown[] }).slots.length).toBeGreaterThan(0);
    expect(JSON.parse(res.content).slots[0]).toHaveProperty("label");
  });

  it("book_meeting books, notifies the owner and reports demo mode", async () => {
    const { ctx, notifier } = makeContext();
    const res = await executeTool(
      "book_meeting",
      { start: "2030-01-07T10:00:00Z", name: "Sam", email: "sam@example.com", time_zone: "Europe/London" },
      ctx,
    );
    expect(res.data).toMatchObject({ start: "2030-01-07T10:00:00.000Z", demo: true });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].text).toContain("I need an AI assistant for my shop.");
  });

  it("book_meeting passes calendar errors back to the model", async () => {
    const { ctx, notifier } = makeContext();
    const res = await executeTool(
      "book_meeting",
      { start: "2030-01-12T10:00:00Z", name: "Sam", email: "sam@example.com", time_zone: "UTC" },
      ctx,
    );
    expect(res).toMatchObject({ isError: true, content: "That time is not an available slot." });
    expect(notifier.sent).toHaveLength(0);
  });

  it("book_meeting is rate limited per IP", async () => {
    const { ctx } = makeContext();
    const input = { start: "2030-01-07T10:00:00Z", name: "Sam", email: "sam@example.com", time_zone: "UTC" };
    for (let i = 0; i < 3; i++) expect((await executeTool("book_meeting", input, ctx)).isError).toBeUndefined();
    expect(await executeTool("book_meeting", input, ctx)).toMatchObject({ isError: true });
  });

  it("save_lead stores the lead and only re-notifies when priority goes up", async () => {
    const { ctx, leads, notifier } = makeContext();
    const lead = { email: "sam@example.com", need: "Shop assistant", service: "ai_assistant", budget: "unknown", timeline: "unknown" };

    const first = await executeTool("save_lead", lead, ctx);
    expect(first.content).toContain("Lead saved");
    expect(first.data).toEqual({ saved: true }); // score is never sent to the client
    expect(leads.leads[0]).toMatchObject({ tier: "warm", score: 40 });
    expect(notifier.sent).toHaveLength(1);

    await executeTool("save_lead", { ...lead, need: "Shop assistant, with FAQs" }, ctx);
    expect(notifier.sent).toHaveLength(1); // same tier: no second email

    await executeTool("save_lead", { ...lead, budget: "over_20k", timeline: "asap" }, ctx);
    expect(notifier.sent).toHaveLength(2);
    expect(notifier.sent[1].subject).toMatch(/^HOT lead/);
  });
});
