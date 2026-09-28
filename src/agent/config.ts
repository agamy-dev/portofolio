import { z } from "zod";

/** Runtime configuration, read from environment variables on each call so tests can override them. */
export function getConfig() {
  const env = process.env;
  const calcomEventTypeId = Number(env.CALCOM_EVENT_TYPE_ID);
  return {
    model: env.ANTHROPIC_MODEL || "claude-opus-5",
    effort: z.enum(["low", "medium", "high"]).catch("low").parse(env.CHAT_EFFORT),
    ownerEmail: env.OWNER_EMAIL || undefined,
    calcom:
      env.CALCOM_API_KEY && Number.isInteger(calcomEventTypeId)
        ? { apiKey: env.CALCOM_API_KEY, eventTypeId: calcomEventTypeId }
        : undefined,
    resend: env.RESEND_API_KEY
      ? { apiKey: env.RESEND_API_KEY, from: env.NOTIFY_FROM_EMAIL || "Portfolio Agent <onboarding@resend.dev>" }
      : undefined,
    leadsFile: env.LEADS_FILE || ".data/leads.json",
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

export type AgentConfig = ReturnType<typeof getConfig>;
