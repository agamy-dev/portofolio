import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileLeadStore, scoreLead, type LeadInput } from "../src/agent/tools/leads";

const base: LeadInput = {
  email: "sam@example.com",
  need: "Website assistant",
  service: "ai_assistant",
  budget: "unknown",
  timeline: "unknown",
};

describe("scoreLead", () => {
  it("rates a funded, urgent, well-matched lead as hot", () => {
    expect(scoreLead({ ...base, name: "Sam", company: "Acme", budget: "over_20k", timeline: "asap" })).toEqual({
      score: 100,
      tier: "hot",
    });
  });

  it("needs a service match to reach warm without budget or timeline info", () => {
    expect(scoreLead(base)).toEqual({ score: 40, tier: "warm" });
    expect(scoreLead({ ...base, service: "other" })).toEqual({ score: 25, tier: "cold" });
  });

  it("puts mid-range leads in the warm tier", () => {
    expect(scoreLead({ ...base, budget: "1k_to_5k", timeline: "within_3_months" }).tier).toBe("warm");
  });
});

describe("FileLeadStore", () => {
  it("creates the file, then merges updates for the same email", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "leads-"));
    const store = new FileLeadStore(path.join(dir, "nested", "leads.json"));
    const lead = { ...base, name: "Sam", score: 40, tier: "warm" as const, createdAt: "t1", updatedAt: "t1" };

    expect(await store.upsert(lead)).toEqual({ previous: undefined });
    const second = await store.upsert({ ...lead, email: "SAM@example.com", name: undefined, budget: "over_20k", updatedAt: "t2" });
    expect(second.previous?.budget).toBe("unknown");

    const all = await store.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "Sam", budget: "over_20k", createdAt: "t1", updatedAt: "t2" });
  });
});
