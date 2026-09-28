/** One turn of the visible conversation, as sent by the client. */
export type ChatTurn = { role: "user" | "assistant"; content: string };

/** Optional facts the embedding website knows about the visitor. */
export type VisitorContext = {
  /** IANA time zone from the visitor's browser, e.g. "Europe/Berlin". */
  timeZone?: string;
  /** Page the visitor is chatting from. */
  pageUrl?: string;
};

/**
 * Events streamed to the client (newline-delimited JSON).
 * Clients should ignore event types they don't recognise.
 */
export type AgentEvent =
  | { type: "block" } // a new text block starts; citations that follow belong to it
  | { type: "text"; text: string }
  | { type: "citation"; title: string; quote: string }
  | { type: "tool_call"; id: string; name: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; data?: unknown }
  | { type: "error"; message: string }
  | { type: "done" };
