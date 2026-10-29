import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { now, tx } from "../db.ts";
import { newId, sha256 } from "../ids.ts";
import { buildBillPaymentPayload, buildPromptPayPayload } from "../promptpay.ts";
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
  slip_attempts: number;
  verify_status: "verifying" | "verified" | "rejected" | "needs_review" | null;
  verify_reason: string | null;
  verify_started_at: string | null;
  verify_retry_at: string | null;
  verify_retries: number;
  slip_trans_ref: string | null;
  ref_code: string | null;
  confirmed_by: "card" | "slip" | "bank" | "manual" | null;
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

export interface PaymentFilter {
  merchantId?: string;
  livemode?: boolean;
  status?: string;
  reference?: string;
  search?: string;
  /** ISO timestamps bounding created_at: from inclusive, to exclusive. */
  from?: string;
  to?: string;
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

/** A slip check that has been "verifying" longer than this is assumed to have crashed. */
export const VERIFICATION_LOCK_MS = 2 * 60_000;

export function verificationLockCutoff(): string {
  return new Date(Date.now() - VERIFICATION_LOCK_MS).toISOString();
}

export const SLIP_MIME_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

/** Ten characters, upper-case letters and digits without look-alikes, valid as a QR Reference 1. */
function newRefCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join("");
}

export class PaymentService {
  /** Returns the Biller ID of the merchant's linked bank account, if any (set by the bank module). */
  private billerLookup: (merchantId: string, livemode: boolean) => string | null = () => null;

  setBillerLookup(fn: (merchantId: string, livemode: boolean) => string | null): void {
    this.billerLookup = fn;
  }

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

  /** @param t table alias prefix such as "p." when the query joins other tables */
  private where(filter: PaymentFilter, t = ""): { where: string[]; args: (string | number)[] } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.from) (where.push(`${t}created_at >= ?`), args.push(filter.from));
    if (filter.to) (where.push(`${t}created_at < ?`), args.push(filter.to));
    if (filter.merchantId) (where.push(`${t}merchant_id = ?`), args.push(filter.merchantId));
    if (filter.livemode !== undefined) (where.push(`${t}livemode = ?`), args.push(filter.livemode ? 1 : 0));
    if (filter.status) (where.push(`${t}status = ?`), args.push(filter.status));
    if (filter.reference) (where.push(`${t}reference = ?`), args.push(filter.reference));
    if (filter.search) {
      const like = `%${filter.search.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      where.push(`(${t}id = ? OR ${t}reference LIKE ? ESCAPE '\\' OR ${t}description LIKE ? ESCAPE '\\')`);
      args.push(filter.search, like, like);
    }
    return { where, args };
  }

  list(filter: PaymentFilter, limit = 50, startingAfter?: string): PaymentRow[] {
    const { where, args } = this.where(filter);
    if (startingAfter) {
      const cursor = this.get(startingAfter);
      if (cursor) (where.push("(created_at, id) < (?, ?)"), args.push(cursor.created_at, cursor.id));
    }
    const sql = `SELECT * FROM payments ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit) as unknown as PaymentRow[];
  }

  /** Rows for a spreadsheet export, newest first, with the merchant name attached. */
  exportRows(filter: PaymentFilter, limit: number): (PaymentRow & { merchant_name: string })[] {
    const { where, args } = this.where(filter, "p.");
    const sql = `SELECT p.*, m.name AS merchant_name FROM payments p JOIN merchants m ON m.id = p.merchant_id
                 ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY p.created_at DESC, p.id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit) as unknown as (PaymentRow & { merchant_name: string })[];
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
      const refCode = newRefCode();
      // With a linked Biller ID the QR carries this payment's code, so the bank's notification names it exactly.
      const billerId = input.method === "promptpay" ? this.billerLookup(merchant.id, livemode) : null;
      const promptpayPayload =
        input.method !== "promptpay"
          ? null
          : billerId
            ? buildBillPaymentPayload(billerId, refCode, input.amount)
            : buildPromptPayPayload(merchant.promptpay_id!, input.amount);

      this.db
        .prepare(
          `INSERT INTO payments (id, merchant_id, livemode, amount, currency, method, status, reference, description,
             metadata, return_url, promptpay_payload, ref_code, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          refCode,
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
  transition(
    id: string,
    to: PaymentStatus,
    extra: {
      failure_reason?: string;
      provider_ref?: string;
      confirmed_by?: PaymentRow["confirmed_by"];
      before?: () => void;
    } = {},
  ): PaymentRow {
    return tx(this.db, () => {
      extra.before?.();
      const from = TRANSITIONS[to];
      const ts = now();
      // A payment whose slip is being checked right now must not expire underneath the check.
      const guard =
        to === "expired"
          ? " AND (verify_status IS NOT 'verifying' OR verify_started_at < ?)"
          : "";
      const guardArgs = to === "expired" ? [verificationLockCutoff()] : [];
      const result = this.db
        .prepare(
          `UPDATE payments SET status = ?, updated_at = ?,
             paid_at = CASE WHEN ? = 'succeeded' THEN ? ELSE paid_at END,
             failure_reason = CASE WHEN ? = 'succeeded' THEN NULL ELSE COALESCE(?, failure_reason) END,
             provider_ref = COALESCE(?, provider_ref),
             confirmed_by = COALESCE(?, confirmed_by)
           WHERE id = ? AND status IN (${from.map(() => "?").join(",")})${guard}`,
        )
        .run(
          to,
          ts,
          to,
          ts,
          to,
          extra.failure_reason ?? null,
          extra.provider_ref ?? null,
          extra.confirmed_by ?? null,
          id,
          ...from,
          ...guardArgs,
        );
      const payment = this.get(id);
      if (!payment) throw new PaymentError(404, "not_found", "Payment not found");
      if (result.changes === 0) {
        throw new PaymentError(409, "invalid_state", `Cannot change payment from '${payment.status}' to '${to}'`);
      }
      this.webhooks.emit(payment.merchant_id, `payment.${to}`, id, this.serialize(payment));
      return payment;
    });
  }

  /** Merchant confirms money arrived for a PromptPay / bank transfer payment. */
  approve(p: PaymentRow): PaymentRow {
    if (p.method === "card") throw new PaymentError(400, "invalid_method", "Card payments are confirmed by the card provider");
    return this.transition(p.id, "succeeded", { confirmed_by: "manual" });
  }

  /** Merchant rejects a slip that is waiting for review. */
  reject(p: PaymentRow, reason: string): PaymentRow {
    if (p.status !== "awaiting_review") {
      throw new PaymentError(409, "invalid_state", "Only payments awaiting review can be rejected");
    }
    return this.transition(p.id, "failed", { failure_reason: reason });
  }

  /** Headline numbers and daily sales (Asia/Bangkok days) for a merchant's dashboard. */
  /** @param merchantId one merchant, or null for the whole gateway */
  summary(merchantId: string | null, livemode: boolean, days = 14) {
    const BKK_OFFSET_MS = 7 * 3600_000;
    const dayKey = (t: number) => new Date(t + BKK_OFFSET_MS).toISOString().slice(0, 10);
    const todayStart = Date.parse(dayKey(Date.now()) + "T00:00:00Z") - BKK_OFFSET_MS;
    const since = new Date(todayStart - (days - 1) * 86400_000).toISOString();
    const mode = livemode ? 1 : 0;

    const paid = this.db
      .prepare(
        `SELECT amount, paid_at FROM payments WHERE ${merchantId ? "merchant_id = ? AND" : ""} livemode = ?
         AND status = 'succeeded' AND paid_at >= ?`,
      )
      .all(...(merchantId ? [merchantId] : []), mode, since) as { amount: number; paid_at: string }[];
    const daily = new Map<string, { amount: number; count: number }>();
    for (let i = days - 1; i >= 0; i--) daily.set(dayKey(todayStart - i * 86400_000), { amount: 0, count: 0 });
    for (const r of paid) {
      const d = daily.get(dayKey(Date.parse(r.paid_at)));
      if (d) (d.amount += r.amount), d.count++;
    }

    const counts = Object.fromEntries(
      (
        this.db
          .prepare(`SELECT status, COUNT(*) AS n FROM payments WHERE ${merchantId ? "merchant_id = ? AND" : ""} livemode = ? GROUP BY status`)
          .all(...(merchantId ? [merchantId] : []), mode) as { status: string; n: number }[]
      ).map((r) => [r.status, r.n]),
    );
    const today = daily.get(dayKey(Date.now()))!;
    const series = [...daily].map(([date, v]) => ({ date, ...v }));
    return {
      today: { amount: today.amount, count: today.count },
      period: {
        days,
        amount: series.reduce((a, d) => a + d.amount, 0),
        count: series.reduce((a, d) => a + d.count, 0),
      },
      awaiting_review: counts.awaiting_review ?? 0,
      pending: counts.pending ?? 0,
      daily: series,
    };
  }

  emitEvent(p: PaymentRow, type: string): void {
    this.webhooks.emit(p.merchant_id, type, p.id, this.serialize(p));
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
    if (result.status === "succeeded") return this.transition(id, "succeeded", { provider_ref: providerRef, confirmed_by: "card" });
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
      payment_code: p.ref_code,
      confirmed_by: p.confirmed_by,
      has_slip: p.slip_path !== null,
      slip_verification:
        p.verify_status && p.verify_status !== "verifying"
          ? {
              status: p.verify_status,
              reason: p.verify_reason,
              trans_ref: p.slip_trans_ref,
              attempts: p.slip_attempts,
              next_retry_at: p.verify_retry_at,
            }
          : null,
      failure_reason: p.failure_reason,
      expires_at: p.expires_at,
      paid_at: p.paid_at,
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  }
}
