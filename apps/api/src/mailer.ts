/** Sends the email sign-in link (§10.1 (3)). One real implementation for now — swap in another provider behind the same interface if needed. */
export interface Mailer {
  sendEmailLink(to: string, link: string): Promise<void>;
}

/**
 * Resend (https://resend.com). `from` defaults to Resend's own shared sender,
 * which needs no domain verification — right for a project with no domain
 * yet. Swap in a verified `from` address once one exists.
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from = "JellySwarm <onboarding@resend.dev>",
  ) {}

  async sendEmailLink(to: string, link: string): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to,
        subject: "Sign in to JellySwarm",
        html: `<p>Click to sign in to JellySwarm:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes and works once.</p>`,
        text: `Sign in to JellySwarm: ${link}\n\nThis link expires in 15 minutes and works once.`,
      }),
    });
    if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}
