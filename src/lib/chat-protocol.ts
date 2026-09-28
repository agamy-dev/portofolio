/** Newline-delimited JSON events streamed from /api/chat to the browser. */
export type ChatEvent =
  | { type: "block" } // a new text block starts; citations that follow belong to it
  | { type: "text"; text: string }
  | { type: "citation"; title: string; quote: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type ChatTurn = { role: "user" | "assistant"; content: string };
