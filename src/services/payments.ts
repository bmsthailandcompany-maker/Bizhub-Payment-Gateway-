import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { now, tx } from "../db.ts";
import { newId, sha256 } from "../ids.ts";
import { buildPromptPayPayload } from "../promptpay.ts";
import type { CardChargeResult, CardProvider } from "../providers/card.ts";
import type { MerchantRow } from "./merchants.ts";
import type { WebhookService } from "./webhooks.ts";

export type PaymentMethod = "promptpay" | "card" | "bank_transfer";
export type PaymentStatus = "pending" | "awaiting_review" | "succeeded" | "failed" | "expired" | "cancelled";

export const FINAL_STATUSES: readonly PaymentStatus[] = ["succeeded", "failed", "expired", "cancelled"];

export interface PaymentRow {
  id: string;
  merchant_id: string;
  livemode: number;
  amount: number;
  currency: string;
  method: PaymentMethod;
  status: PaymentStatus;
  reference: string | null;
  description: string | null;
  metadata: string;
  return_url: string | null;
  promptpay_payload: string | null;
  provider_ref: string | null;
  failure_reason: string | null;
  slip_path: string | null;
  slip_mime: string | null;
  expires_at: string;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentInput {
  amount: number;
  currency: "THB";
  method: PaymentMethod;
  reference?: string;
  description?: string;
  metadata?: Record<string, string>;
  return_url?: string;
  expires_in?: number;
}

export class PaymentError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Which statuses each target status may be reached from. */
const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  pending: [],
  awaiting_review: ["pending"],
  succeeded: ["pending", "awaiting_review"],
  failed: ["pending", "awaiting_review"],
  expired: ["pending"],
  cancelled: ["pending"],
};

const CHARGE_IN_FLIGHT = "__charging__";

export const SLIP_MIME_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

export class PaymentService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly webhooks: WebhookService,
    private readonly cardProviders: { test: CardProvider; live: CardProvider | null },
  ) {}

  get slipDir(): string {
    return path.join(this.config.dataDir, "slips");
  }

  get(id: string): PaymentRow | undefined {
    return this.db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRow | undefined;
  }

  getForMerchant(id: string, merchantId: string, livemode: boolean): PaymentRow {
    const p = this.get(id);
    if (!p || p.merchant_id !== merchantId || (p.livemode === 1) !== livemode) {
      throw new PaymentError(404, "not_found", "Payment not found");
    }
    return p;
  }

  list(
    filter: { merchantId?: string; livemode?: boolean; status?: string; reference?: string },
    limit = 50,
    startingAfter?: string,
  ): PaymentRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.merchantId) (where.push("merchant_id = ?"), args.push(filter.merchantId));
    if (filter.livemode !== undefined) (where.push("livemode = ?"), args.push(filter.livemode ? 1 : 0));
    if (filter.status) (where.push("status = ?"), args.push(filter.status));
    if (filter.reference) (where.push("reference = ?"), args.push(filter.reference));
    if (startingAfter) {
      const cursor = this.get(startingAfter);
      if (cursor) (where.push("(created_at, id) < (?, ?)"), args.push(cursor.created_at, cursor.id));
    }
    const sql = `SELECT * FROM payments ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit) as unknown as PaymentRow[];
  }

  create(merchant: MerchantRow, livemode: boolean, input: CreatePaymentInput, idempotencyKey?: string): PaymentRow {
    if (input.method === "promptpay" && !merchant.promptpay_id) {
      throw new PaymentError(400, "method_unavailable", "Merchant has no PromptPay ID configured");
    }
    if (input.method === "bank_transfer" && !merchant.bank_account_no) {
      throw new PaymentError(400, "method_unavailable", "Merchant has no bank account configured");
    }
    if (input.method === "card" && livemode && !this.cardProviders.live) {
      throw new PaymentError(400, "method_unavailable", "Live card payments are not configured on this gateway");
    }

    return tx(this.db, () => {
      const requestHash = sha256(JSON.stringify(input));
      if (idempotencyKey) {
        const existing = this.db
          .prepare("SELECT request_hash, payment_id FROM idempotency_keys WHERE merchant_id = ? AND key = ?")
          .get(merchant.id, idempotencyKey) as { request_hash: string; payment_id: string } | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new PaymentError(409, "idempotency_conflict", "Idempotency-Key was reused with different parameters");
          }
          return this.get(existing.payment_id)!;
        }
      }

      const id = newId("pay");
      const ts = now();
      const ttl = input.expires_in ?? this.config.defaultPaymentTtlSeconds;
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      const promptpayPayload =
        input.method === "promptpay" ? buildPromptPayPayload(merchant.promptpay_id!, input.amount) : null;

      this.db
        .prepare(
          `INSERT INTO payments (id, merchant_id, livemode, amount, currency, method, status, reference, description,
             metadata, return_url, promptpay_payload, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          merchant.id,
          livemode ? 1 : 0,
          input.amount,
          input.currency,
          input.method,
          input.reference ?? null,
          input.description ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.return_url ?? null,
          promptpayPayload,
          expiresAt,
          ts,
          ts,
        );
      if (idempotencyKey) {
        this.db
          .prepare(
            "INSERT INTO idempotency_keys (merchant_id, key, request_hash, payment_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(merchant.id, idempotencyKey, requestHash, id, ts);
      }
      const payment = this.get(id)!;
      this.webhooks.emit(merchant.id, "payment.created", id, this.serialize(payment));
      return payment;
    });
  }

  /**
   * Atomically moves a payment to `to` if its current status allows it, then emits
   * `payment.<to>`. Returns the updated payment, or throws if the transition is invalid.
   */
  transition(id: string, to: PaymentStatus, extra: { failure_reason?: string; provider_ref?: string } = {}): PaymentRow {
    return tx(this.db, () => {
      const from = TRANSITIONS[to];
      const ts = now();
      const result = this.db
        .prepare(
          `UPDATE payments SET status = ?, updated_at = ?,
             paid_at = CASE WHEN ? = 'succeeded' THEN ? ELSE paid_at END,
             failure_reason = CASE WHEN ? = 'succeeded' THEN NULL ELSE COALESCE(?, failure_reason) END,
             provider_ref = COALESCE(?, provider_ref)
           WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
        )
        .run(to, ts, to, ts, to, extra.failure_reason ?? null, extra.provider_ref ?? null, id, ...from);
      const payment = this.get(id);
      if (!payment) throw new PaymentError(404, "not_found", "Payment not found");
      if (result.changes === 0) {
        throw new PaymentError(409, "invalid_state", `Cannot change payment from '${payment.status}' to '${to}'`);
      }
      this.webhooks.emit(payment.merchant_id, `payment.${to}`, id, this.serialize(payment));
      return payment;
    });
  }

  /** Marks a pending payment expired if its time is up. Returns the fresh row. */
  expireIfDue(p: PaymentRow): PaymentRow {
    if (p.status === "pending" && p.expires_at <= now()) {
      try {
        return this.transition(p.id, "expired");
      } catch (err) {
        if (!(err instanceof PaymentError)) throw err;
        return this.get(p.id)!;
      }
    }
    return p;
  }

  sweepExpired(): number {
    const due = this.db
      .prepare("SELECT * FROM payments WHERE status = 'pending' AND expires_at <= ? LIMIT 500")
      .all(now()) as unknown as PaymentRow[];
    for (const p of due) this.expireIfDue(p);
    return due.length;
  }

  /** Stores a transfer slip uploaded from the checkout page and queues it for merchant review. */
  attachSlip(id: string, mime: string, data: Buffer): PaymentRow {
    const p = this.expireIfDue(this.requireCheckout(id));
    if (p.method === "card") throw new PaymentError(400, "invalid_method", "Slips are only for PromptPay and bank transfer");
    if (p.status !== "pending") throw new PaymentError(409, "invalid_state", `Payment is already ${p.status}`);
    const ext = SLIP_MIME_TYPES[mime];
    if (!ext) throw new PaymentError(400, "invalid_file", "Slip must be a JPEG, PNG, WebP or PDF file");

    fs.mkdirSync(this.slipDir, { recursive: true });
    const file = `${p.id}${ext}`;
    fs.writeFileSync(path.join(this.slipDir, file), data);
    this.db.prepare("UPDATE payments SET slip_path = ?, slip_mime = ? WHERE id = ?").run(file, mime, p.id);
    return this.transition(p.id, "awaiting_review");
  }

  readSlip(p: PaymentRow): { mime: string; data: Buffer } | undefined {
    if (!p.slip_path || !p.slip_mime) return undefined;
    return { mime: p.slip_mime, data: fs.readFileSync(path.join(this.slipDir, path.basename(p.slip_path))) };
  }

  private cardProviderFor(p: PaymentRow): CardProvider {
    const provider = p.livemode === 1 ? this.cardProviders.live : this.cardProviders.test;
    if (!provider) throw new PaymentError(400, "method_unavailable", "Card payments are not configured");
    return provider;
  }

  async chargeCard(id: string, token: string): Promise<{ payment: PaymentRow; authorizeUri?: string }> {
    const p = this.expireIfDue(this.requireCheckout(id));
    if (p.method !== "card") throw new PaymentError(400, "invalid_method", "Payment is not a card payment");
    if (p.status !== "pending") throw new PaymentError(409, "invalid_state", `Payment is already ${p.status}`);
    const provider = this.cardProviderFor(p);

    // Claim the payment before calling the provider so concurrent submits cannot double-charge.
    const claimed = this.db
      .prepare("UPDATE payments SET provider_ref = ? WHERE id = ? AND status = 'pending' AND provider_ref IS NULL")
      .run(CHARGE_IN_FLIGHT, p.id);
    if (claimed.changes === 0) throw new PaymentError(409, "charge_in_progress", "A charge is already in progress");

    let result: CardChargeResult;
    try {
      result = await provider.charge({
        amount: p.amount,
        currency: p.currency,
        token,
        description: p.description ?? `Payment ${p.id}`,
        returnUri: `${this.config.publicBaseUrl}/checkout/${p.id}/card-return`,
        paymentId: p.id,
      });
    } catch (err) {
      this.db.prepare("UPDATE payments SET provider_ref = NULL WHERE id = ? AND provider_ref = ?").run(p.id, CHARGE_IN_FLIGHT);
      throw new PaymentError(502, "provider_error", err instanceof Error ? err.message : "Card provider error");
    }
    return { payment: this.applyCardResult(p.id, result), authorizeUri: result.authorizeUri };
  }

  /** Re-checks a card charge with the provider (after 3-D Secure redirect). */
  async refreshCard(id: string): Promise<PaymentRow> {
    const p = this.requireCheckout(id);
    if (p.method !== "card" || p.status !== "pending" || !p.provider_ref || p.provider_ref === CHARGE_IN_FLIGHT) return p;
    return this.applyCardResult(p.id, await this.cardProviderFor(p).retrieve(p.provider_ref));
  }

  private applyCardResult(id: string, result: CardChargeResult): PaymentRow {
    const providerRef = result.providerRef ?? undefined;
    if (result.status === "succeeded") return this.transition(id, "succeeded", { provider_ref: providerRef });
    if (result.status === "failed") {
      // A declined card leaves the payment open so the customer can retry with another card until it expires.
      this.db
        .prepare("UPDATE payments SET provider_ref = NULL, failure_reason = ?, updated_at = ? WHERE id = ?")
        .run(result.failureReason ?? "card_failed", now(), id);
      return this.get(id)!;
    }
    this.db.prepare("UPDATE payments SET provider_ref = ?, updated_at = ? WHERE id = ?").run(providerRef ?? null, now(), id);
    return this.get(id)!;
  }

  private requireCheckout(id: string): PaymentRow {
    const p = this.get(id);
    if (!p) throw new PaymentError(404, "not_found", "Payment not found");
    return p;
  }

  serialize(p: PaymentRow) {
    const base = this.config.publicBaseUrl;
    return {
      id: p.id,
      object: "payment",
      livemode: p.livemode === 1,
      amount: p.amount,
      currency: p.currency,
      method: p.method,
      status: p.status,
      reference: p.reference,
      description: p.description,
      metadata: JSON.parse(p.metadata) as Record<string, string>,
      checkout_url: `${base}/checkout/${p.id}`,
      return_url: p.return_url,
      promptpay: p.promptpay_payload
        ? { payload: p.promptpay_payload, qr_image_url: `${base}/checkout/${p.id}/qr.png` }
        : null,
      has_slip: p.slip_path !== null,
      failure_reason: p.failure_reason,
      expires_at: p.expires_at,
      paid_at: p.paid_at,
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  }
}
