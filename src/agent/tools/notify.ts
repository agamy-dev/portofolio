export interface Notifier {
  send(message: { subject: string; text: string }): Promise<void>;
}

/** Emails the site owner through Resend: https://resend.com/docs/api-reference/emails/send-email */
export class ResendNotifier implements Notifier {
  constructor(
    private readonly opts: { apiKey: string; from: string; to: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send({ subject, text }: { subject: string; text: string }) {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.opts.from, to: [this.opts.to], subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}

/** Used when email isn't configured: prints the notification to the server log. */
export class ConsoleNotifier implements Notifier {
  async send({ subject, text }: { subject: string; text: string }) {
    console.log(`[notify] ${subject}\n${text}`);
  }
}
