import dns from "node:dns/promises";
import net from "node:net";
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

/** Loopback, private, link-local (cloud metadata), CGNAT, multicast and other non-public ranges. */
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv6");
}

export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]!);
  const family = net.isIP(ip);
  if (family === 0) return false;
  return !BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export type ResolveHost = (hostname: string) => Promise<string[]>;

const resolveWithDns: ResolveHost = async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export interface WebhookOptions {
  /** Looks up a webhook host's addresses (overridable in tests). */
  resolveHost?: ResolveHost;
  /** Allow deliveries to private and loopback addresses (development only). */
  allowPrivate?: boolean;
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

  private readonly resolveHost: ResolveHost;
  private readonly allowPrivate: boolean;

  constructor(
    private readonly db: Db,
    private readonly fetchImpl: typeof fetch = fetch,
    opts: WebhookOptions = {},
  ) {
    this.resolveHost = opts.resolveHost ?? resolveWithDns;
    this.allowPrivate = opts.allowPrivate ?? false;
  }

  /**
   * A merchant chooses its webhook URL, so the gateway must not be usable to reach its own network
   * (localhost, the cloud metadata service, other internal hosts). Returns why a URL is refused.
   */
  private async refusal(url: string): Promise<string | null> {
    if (this.allowPrivate) return null;
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return "invalid_url";
    }
    if (host === "localhost" || host.endsWith(".localhost")) return "blocked_address";
    let addresses: string[];
    try {
      addresses = net.isIP(host) ? [host] : await this.resolveHost(host);
    } catch {
      return null; // DNS failure: let the request fail normally and be retried
    }
    return addresses.length && addresses.every(isPublicAddress) ? null : "blocked_address";
  }

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
    const refused = await this.refusal(d.url);
    if (refused) {
      // Never retried, and no detail about the target is recorded for the merchant to read.
      this.db
        .prepare("UPDATE webhook_deliveries SET status='failed', attempts=?, last_status_code=NULL, last_error=?, updated_at=? WHERE id=?")
        .run(d.attempts + 1, "webhook URL points to a private or reserved address", now(), d.id);
      return;
    }
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
