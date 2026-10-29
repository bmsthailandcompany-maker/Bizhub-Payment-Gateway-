import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { hmacSha256, newId, randomToken, safeEqual } from "../ids.ts";
import type { AuditService } from "./audit.ts";
import { PaymentError, type PaymentRow, type PaymentService } from "./payments.ts";

export interface BankConnectionRow {
  id: string;
  merchant_id: string;
  livemode: number;
  label: string;
  biller_id: string | null;
  secret: string;
  active: number;
  last_event_at: string | null;
  created_at: string;
}

/** What a bank (or a relay forwarding the bank's alerts) reports for one incoming transfer. */
export interface BankNotification {
  trans_ref: string;
  /** Baht, as a number or a string with up to two decimals ("150.00"). */
  amount: number | string;
  paid_at?: string;
  /** Reference 1 from a bill-payment QR: the payment code. */
  ref1?: string;
  ref2?: string;
  payer_name?: string;
}

export type BankOutcome =
  | "matched"
  | "duplicate"
  | "amount_mismatch"
  | "already_paid"
  | "paid_after_close"
  | "ambiguous"
  | "unmatched";

export interface BankResult {
  outcome: BankOutcome;
  reason?: string;
  payment_id?: string | null;
  event_id?: string;
}

const SIGNATURE_TOLERANCE_S = 300;
/** How far around a payment's open window a transfer may land and still be matched by amount. */
const MATCH_GRACE_MS = 10 * 60_000;

export function serializeConnection(c: BankConnectionRow) {
  return {
    id: c.id,
    livemode: c.livemode === 1,
    label: c.label,
    biller_id: c.biller_id,
    matching: c.biller_id ? "reference" : "amount",
    active: c.active === 1,
    last_event_at: c.last_event_at,
    created_at: c.created_at,
  };
}

/** Parses baht into satang without floating-point surprises; returns null when not a valid amount. */
export function parseBaht(v: number | string): number | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(2) : "") : v.trim().replace(/,/g, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  if (typeof v === "number" && Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/**
 * Linked bank accounts and the incoming-money notifications they send. A matched notification
 * marks the payment paid with no slip needed; anything that cannot be matched with certainty is
 * kept for the merchant instead of guessed.
 */
export class BankService {
  constructor(
    private readonly db: Db,
    private readonly payments: PaymentService,
    private readonly audit: AuditService,
  ) {
    payments.setBillerLookup((merchantId, livemode) => this.active(merchantId, livemode)?.biller_id ?? null);
  }

  get(id: string): BankConnectionRow | undefined {
    return this.db.prepare("SELECT * FROM bank_connections WHERE id = ?").get(id) as BankConnectionRow | undefined;
  }

  active(merchantId: string, livemode: boolean): BankConnectionRow | undefined {
    return this.db
      .prepare("SELECT * FROM bank_connections WHERE merchant_id = ? AND livemode = ? AND active = 1")
      .get(merchantId, livemode ? 1 : 0) as BankConnectionRow | undefined;
  }

  listForMerchant(merchantId: string): BankConnectionRow[] {
    return this.db
      .prepare("SELECT * FROM bank_connections WHERE merchant_id = ? AND active = 1 ORDER BY livemode DESC")
      .all(merchantId) as unknown as BankConnectionRow[];
  }

  /** Links (or re-links) the account for one mode; the previous link stops accepting notifications. */
  connect(merchantId: string, livemode: boolean, input: { label: string; biller_id?: string | null }): BankConnectionRow {
    this.db.prepare("UPDATE bank_connections SET active = 0 WHERE merchant_id = ? AND livemode = ? AND active = 1").run(merchantId, livemode ? 1 : 0);
    const id = newId("bnk");
    this.db
      .prepare(
        "INSERT INTO bank_connections (id, merchant_id, livemode, label, biller_id, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, merchantId, livemode ? 1 : 0, input.label, input.biller_id?.replace(/\D/g, "") || null, "bnksec_" + randomToken(32), now());
    return this.get(id)!;
  }

  rotateSecret(id: string): string {
    const secret = "bnksec_" + randomToken(32);
    this.db.prepare("UPDATE bank_connections SET secret = ? WHERE id = ?").run(secret, id);
    return secret;
  }

  disconnect(id: string): void {
    this.db.prepare("UPDATE bank_connections SET active = 0 WHERE id = ?").run(id);
  }

  events(merchantId: string, livemode: boolean, limit = 50) {
    return this.db
      .prepare(
        `SELECT e.id, e.trans_ref, e.amount, e.ref1, e.payer_name, e.paid_at, e.outcome, e.reason, e.payment_id, e.created_at,
                p.reference AS payment_reference, p.description AS payment_description
         FROM bank_events e LEFT JOIN payments p ON p.id = e.payment_id
         WHERE e.merchant_id = ? AND e.livemode = ? ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(merchantId, livemode ? 1 : 0, limit);
  }

  /** Checks `Bizhub-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` within 5 minutes. */
  verifySignature(conn: BankConnectionRow, header: string | undefined, rawBody: string, nowS = Math.floor(Date.now() / 1000)): boolean {
    if (!header) return false;
    const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
    const t = Number(parts.t);
    if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowS - t) > SIGNATURE_TOLERANCE_S) return false;
    return safeEqual(hmacSha256(conn.secret, `${t}.${rawBody}`), parts.v1);
  }

  /** Records a notification and, when it identifies one open payment with the right amount, marks it paid. */
  handle(conn: BankConnectionRow, n: BankNotification): BankResult {
    const amount = parseBaht(n.amount);
    if (amount === null || amount <= 0) throw new PaymentError(400, "invalid_amount", "amount must be baht with at most 2 decimals");
    const transRef = String(n.trans_ref ?? "").trim();
    if (!transRef || transRef.length > 100) throw new PaymentError(400, "invalid_trans_ref", "trans_ref is required");
    const paidAt = n.paid_at && !Number.isNaN(Date.parse(n.paid_at)) ? new Date(n.paid_at).toISOString() : now();
    const ref1 = n.ref1?.trim().toUpperCase() || null;

    // Claim the bank transaction first: the UNIQUE key makes a repeated notification a no-op.
    const eventId = newId("bev");
    try {
      this.db
        .prepare(
          `INSERT INTO bank_events (id, connection_id, merchant_id, livemode, trans_ref, amount, ref1, ref2, payer_name, paid_at, outcome, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?)`,
        )
        .run(eventId, conn.id, conn.merchant_id, conn.livemode, transRef, amount, ref1, n.ref2?.trim() || null, n.payer_name?.slice(0, 120) || null, paidAt, now());
    } catch {
      const prior = this.db
        .prepare("SELECT id, payment_id FROM bank_events WHERE connection_id = ? AND trans_ref = ?")
        .get(conn.id, transRef) as { id: string; payment_id: string | null } | undefined;
      return { outcome: "duplicate", payment_id: prior?.payment_id ?? null, event_id: prior?.id };
    }

    const result = this.match(conn, transRef, amount, paidAt, ref1);
    this.db
      .prepare("UPDATE bank_events SET outcome = ?, reason = ?, payment_id = ? WHERE id = ?")
      .run(result.outcome, result.reason ?? null, result.payment_id ?? null, eventId);
    this.db.prepare("UPDATE bank_connections SET last_event_at = ? WHERE id = ?").run(now(), conn.id);
    this.audit.log({
      merchantId: conn.merchant_id,
      actor: { kind: "system", id: conn.id, name: `ธนาคาร (${conn.label})`, role: "", mustChangePassword: false },
      action: result.outcome === "matched" ? "payment.bank_confirmed" : "bank.notification",
      target: result.payment_id ?? transRef,
      details: { amount, outcome: result.outcome, reason: result.reason },
    });
    return { ...result, event_id: eventId };
  }

  private match(conn: BankConnectionRow, transRef: string, amount: number, paidAt: string, ref1: string | null): BankResult {
    const mode = conn.livemode;
    if (ref1) {
      const p = this.db
        .prepare("SELECT * FROM payments WHERE merchant_id = ? AND livemode = ? AND ref_code = ?")
        .get(conn.merchant_id, mode, ref1) as PaymentRow | undefined;
      if (!p) return { outcome: "unmatched", reason: "unknown_reference" };
      return this.settle(p, transRef, amount);
    }
    // No reference: only an exact amount on exactly one payment that was open at that time counts.
    const t = Date.parse(paidAt);
    const open = (
      this.db
        .prepare(
          `SELECT * FROM payments WHERE merchant_id = ? AND livemode = ? AND amount = ?
             AND method IN ('promptpay', 'bank_transfer') AND status IN ('pending', 'awaiting_review')`,
        )
        .all(conn.merchant_id, mode, amount) as unknown as PaymentRow[]
    ).filter((p) => Date.parse(p.created_at) - MATCH_GRACE_MS <= t && t <= Date.parse(p.expires_at) + MATCH_GRACE_MS);
    if (open.length === 1) return this.settle(open[0]!, transRef, amount);
    if (open.length > 1) return { outcome: "ambiguous", reason: `${open.length}_open_payments_same_amount` };
    return { outcome: "unmatched", reason: "no_open_payment_with_amount" };
  }

  private settle(p: PaymentRow, transRef: string, amount: number): BankResult {
    if (p.status === "succeeded") return { outcome: "already_paid", payment_id: p.id };
    if (!["pending", "awaiting_review"].includes(p.status)) {
      // Money arrived for a payment that is already closed: the merchant decides (refund or honour).
      return { outcome: "paid_after_close", reason: p.status, payment_id: p.id };
    }
    if (amount !== p.amount) {
      if (p.status === "pending") {
        this.payments.transition(p.id, "awaiting_review", {
          before: () =>
            this.db
              .prepare("UPDATE payments SET verify_status = 'needs_review', verify_reason = ? WHERE id = ?")
              .run(amount < p.amount ? "bank_amount_too_low" : "bank_amount_too_high", p.id),
        });
      }
      return { outcome: "amount_mismatch", reason: amount < p.amount ? "amount_too_low" : "amount_too_high", payment_id: p.id };
    }
    try {
      this.payments.transition(p.id, "succeeded", {
        confirmed_by: "bank",
        before: () => {
          // The same bank transaction may also come in as a slip; it can pay for one payment only.
          const used = this.db.prepare("SELECT payment_id FROM used_slips WHERE trans_ref = ?").get(transRef) as
            | { payment_id: string }
            | undefined;
          if (used && used.payment_id !== p.id) throw new PaymentError(409, "transfer_used", "This transfer already paid another payment");
          if (!used) this.db.prepare("INSERT INTO used_slips (trans_ref, payment_id, created_at) VALUES (?, ?, ?)").run(transRef, p.id, now());
          this.db
            .prepare("UPDATE payments SET slip_trans_ref = ?, verify_retry_at = NULL WHERE id = ?")
            .run(transRef, p.id);
        },
      });
      return { outcome: "matched", payment_id: p.id };
    } catch (err) {
      if (err instanceof PaymentError && err.code === "transfer_used") return { outcome: "duplicate", reason: "transfer_used_elsewhere", payment_id: p.id };
      if (err instanceof PaymentError && err.code === "invalid_state") return { outcome: "already_paid", payment_id: p.id };
      throw err;
    }
  }

  /**
   * A person resolves a notification the matcher left open (no match, or several payments with the
   * same amount) by choosing the payment it pays for. Amount and reuse checks still apply.
   */
  assign(merchantId: string, livemode: boolean, eventId: string, p: PaymentRow): BankResult {
    const e = this.db
      .prepare("SELECT * FROM bank_events WHERE id = ? AND merchant_id = ? AND livemode = ?")
      .get(eventId, merchantId, livemode ? 1 : 0) as { id: string; trans_ref: string; amount: number; outcome: string } | undefined;
    if (!e) throw new PaymentError(404, "not_found", "ไม่พบรายการเงินเข้า");
    if (!["unmatched", "ambiguous"].includes(e.outcome)) throw new PaymentError(409, "already_resolved", "รายการเงินเข้านี้จับคู่แล้ว");
    const result = this.settle(p, e.trans_ref, e.amount);
    this.db
      .prepare("UPDATE bank_events SET outcome = ?, reason = ?, payment_id = ? WHERE id = ?")
      .run(result.outcome, result.outcome === "matched" ? "assigned_by_staff" : (result.reason ?? null), result.payment_id ?? null, e.id);
    return { ...result, event_id: e.id };
  }

  /** Test mode only: pretends the bank reported a transfer for this payment. */
  simulate(conn: BankConnectionRow, p: PaymentRow, amount = p.amount): BankResult {
    if (conn.livemode === 1) throw new PaymentError(400, "test_mode_only", "Simulation is only available in test mode");
    return this.handle(conn, {
      trans_ref: "TEST" + randomToken(12).toUpperCase(),
      amount: (amount / 100).toFixed(2),
      ref1: conn.biller_id ? (p.ref_code ?? undefined) : undefined,
      payer_name: "ลูกค้าทดสอบ",
    });
  }
}
