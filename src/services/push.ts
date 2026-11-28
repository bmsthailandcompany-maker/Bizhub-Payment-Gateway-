import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { merchantCan, type MerchantRole } from "../auth/permissions.ts";
import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { newId } from "../ids.ts";
import type { PaymentRow, PaymentService } from "./payments.ts";
import { PaymentError } from "./payments.ts";

/** What a device can ask to be told about. */
export const PUSH_EVENTS = ["paid", "review"] as const;
export type PushEvent = (typeof PUSH_EVENTS)[number];

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface SubscriptionRow {
  id: string;
  merchant_id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  events: string;
  failures: number;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export type PushSender = (sub: PushSubscriptionInput, payload: string) => Promise<void>;

const baht = (satang: number) => "฿" + (satang / 100).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The server's VAPID key pair identifies it to the browsers' push services. Taken from the environment
 * when set, otherwise made once and kept in DATA_DIR so existing subscriptions keep working across deploys.
 */
export function loadVapidKeys(dataDir: string, env: NodeJS.ProcessEnv = process.env): VapidKeys {
  const subject = env.VAPID_SUBJECT || "mailto:support@bizhubpay.com";
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject };
  if (dataDir === ":memory:") return { ...webpush.generateVAPIDKeys(), subject };
  const file = path.join(dataDir, "vapid.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.publicKey && saved.privateKey) return { publicKey: saved.publicKey, privateKey: saved.privateKey, subject };
  } catch {
    /* first start */
  }
  const keys = webpush.generateVAPIDKeys();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return { ...keys, subject };
}

/**
 * Phone / desktop notifications for shop staff: money received, and a slip or transfer waiting for
 * someone to check. Only live-mode payments, only people whose role can see payments, checked at send time.
 */
export class PushService {
  private readonly send: PushSender;

  constructor(
    private readonly db: Db,
    payments: PaymentService,
    readonly vapid: VapidKeys,
    sender?: PushSender,
  ) {
    this.send =
      sender ??
      (async (sub, payload) => {
        await webpush.sendNotification(sub, payload, {
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          TTL: 60 * 60,
          urgency: "high",
          timeout: 10_000,
        });
      });
    // Listeners run inside the payment's transaction: send only after it has committed, and only if
    // the payment is still in the state we are announcing.
    payments.onTransition((p, to) => {
      if (p.livemode !== 1) return;
      const event: PushEvent | null = to === "succeeded" ? "paid" : to === "awaiting_review" ? "review" : null;
      if (!event) return;
      setImmediate(() => {
        const current = payments.get(p.id);
        if (current?.status !== to) return;
        this.notifyMerchant(current, event).catch(() => {});
      });
    });
  }

  subscribe(merchantId: string, userId: string, sub: PushSubscriptionInput, events: PushEvent[]): void {
    // One row per browser endpoint: signing in as someone else on the same phone takes the device over.
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, merchant_id, user_id, endpoint, p256dh, auth, events, failures, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(endpoint) DO UPDATE SET merchant_id = excluded.merchant_id, user_id = excluded.user_id,
           p256dh = excluded.p256dh, auth = excluded.auth, events = excluded.events, failures = 0`,
      )
      .run(newId("push"), merchantId, userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, events.join(","), now());
  }

  unsubscribe(userId: string, endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(userId, endpoint);
  }

  /** The device's current settings, or null when this endpoint is not subscribed for this user. */
  status(userId: string, endpoint: string): { events: PushEvent[] } | null {
    const row = this.db.prepare("SELECT events FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").get(userId, endpoint) as
      | { events: string }
      | undefined;
    return row ? { events: row.events.split(",").filter(Boolean) as PushEvent[] } : null;
  }

  async test(userId: string, endpoint: string): Promise<void> {
    const row = this.db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").get(userId, endpoint) as
      | SubscriptionRow
      | undefined;
    if (!row) throw new PaymentError(404, "not_subscribed", "อุปกรณ์นี้ยังไม่ได้เปิดการแจ้งเตือน");
    const ok = await this.deliver(row, { title: "BIZHUB PAY", body: "การแจ้งเตือนทำงานแล้ว ✓", url: "/dashboard", tag: "test" });
    if (!ok) throw new PaymentError(502, "push_failed", "ส่งการแจ้งเตือนไม่สำเร็จ ลองปิดแล้วเปิดใหม่");
  }

  async notifyMerchant(p: PaymentRow, event: PushEvent): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT s.* , u.role AS role FROM push_subscriptions s
         JOIN merchant_users u ON u.id = s.user_id AND u.merchant_id = s.merchant_id AND u.active = 1
         WHERE s.merchant_id = ?`,
      )
      .all(p.merchant_id) as unknown as (SubscriptionRow & { role: MerchantRole })[];
    const ref = p.reference || p.description || "";
    const message =
      event === "paid"
        ? { title: `💰 เงินเข้า ${baht(p.amount)}`, body: ref ? `ชำระสำเร็จ · ${ref}` : "มีรายการชำระสำเร็จ", url: "/dashboard#payments", tag: "paid-" + p.id }
        : { title: `🔎 รอตรวจสอบ ${baht(p.amount)}`, body: (ref ? ref + " · " : "") + "มีสลิปหรือเงินโอนที่ต้องตรวจ", url: "/dashboard#review", tag: "review-" + p.id };
    let sent = 0;
    for (const row of rows) {
      if (!row.events.split(",").includes(event) || !merchantCan(row.role, "payments.view")) continue;
      if (await this.deliver(row, message)) sent++;
    }
    return sent;
  }

  private async deliver(row: SubscriptionRow, message: { title: string; body: string; url: string; tag: string }): Promise<boolean> {
    try {
      await this.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(message));
      this.db.prepare("UPDATE push_subscriptions SET failures = 0, last_sent_at = ? WHERE id = ?").run(now(), row.id);
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410: the browser dropped this subscription (app removed, permission revoked).
      if (status === 404 || status === 410 || row.failures >= 9) this.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(row.id);
      else this.db.prepare("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?").run(row.id);
      return false;
    }
  }
}
