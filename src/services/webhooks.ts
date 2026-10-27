import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { hmacSha256, newId } from "../ids.ts";

/** Retry schedule after a failed attempt (ms). Delivery is abandoned after the last one. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000, 24 * 3600_000];
const TIMEOUT_MS = 10_000;

export const SIGNATURE_HEADER = "Bizhub-Signature";

/** Header value: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacSha256(secret, `${timestamp}.${body}`)}`;
}

interface DueDelivery {
  id: string;
  url: string;
  attempts: number;
  payload: string;
  webhook_secret: string;
}

export class WebhookService {
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Records an event and, if the merchant has a webhook URL, queues its delivery. */
  emit(merchantId: string, type: string, paymentId: string, data: unknown): string {
    const eventId = newId("evt");
    const ts = now();
    const payload = JSON.stringify({ id: eventId, object: "event", type, created_at: ts, data });
    this.db
      .prepare("INSERT INTO events (id, merchant_id, type, payment_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(eventId, merchantId, type, paymentId, payload, ts);
    const merchant = this.db.prepare("SELECT webhook_url FROM merchants WHERE id = ?").get(merchantId) as
      | { webhook_url: string | null }
      | undefined;
    if (merchant?.webhook_url) {
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries (id, event_id, merchant_id, url, status, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(newId("whd"), eventId, merchantId, merchant.webhook_url, ts, ts, ts);
    }
    return eventId;
  }

  /** Sends every delivery that is due. Safe to call repeatedly; overlapping calls are skipped. */
  async processDue(limit = 20): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = this.db
        .prepare(
          `SELECT d.id, d.url, d.attempts, e.payload, m.webhook_secret
           FROM webhook_deliveries d
           JOIN events e ON e.id = d.event_id
           JOIN merchants m ON m.id = d.merchant_id
           WHERE d.status = 'pending' AND d.next_attempt_at <= ?
           ORDER BY d.next_attempt_at LIMIT ?`,
        )
        .all(now(), limit) as unknown as DueDelivery[];
      for (const d of due) await this.deliver(d);
      return due.length;
    } finally {
      this.running = false;
    }
  }

  private async deliver(d: DueDelivery): Promise<void> {
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const res = await this.fetchImpl(d.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Bizhub-Webhooks/1.0",
          [SIGNATURE_HEADER]: signPayload(d.webhook_secret, d.payload),
        },
        body: d.payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "manual",
      });
      statusCode = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const attempts = d.attempts + 1;
    const ts = now();
    if (!error) {
      this.db
        .prepare(
          "UPDATE webhook_deliveries SET status='delivered', attempts=?, last_status_code=?, last_error=NULL, updated_at=? WHERE id=?",
        )
        .run(attempts, statusCode, ts, d.id);
      return;
    }
    const backoff = BACKOFF_MS[attempts - 1];
    const status = backoff === undefined ? "failed" : "pending";
    const next = new Date(Date.now() + (backoff ?? 0)).toISOString();
    this.db
      .prepare(
        "UPDATE webhook_deliveries SET status=?, attempts=?, last_status_code=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?",
      )
      .run(status, attempts, statusCode, error, next, ts, d.id);
  }
}
