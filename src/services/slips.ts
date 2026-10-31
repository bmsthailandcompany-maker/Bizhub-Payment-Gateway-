import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { newId } from "../ids.ts";
import { evaluateSlip, type SlipDecision } from "../slip/evaluate.ts";
import type { SlipVerifier, VerifiedSlip } from "../slip/types.ts";
import type { MerchantService } from "./merchants.ts";
import {
  PaymentError,
  type PaymentRow,
  type PaymentService,
  SLIP_MIME_TYPES,
  verificationLockCutoff,
} from "./payments.ts";

/** Uploads a customer may make for one payment (each one may cost provider quota). */
export const MAX_SLIP_ATTEMPTS = 5;
/** Re-checks of a slip the bank could not confirm yet, before leaving it to the merchant. */
export const MAX_VERIFY_RETRIES = 6;
const RETRY_DELAYS_S = [2 * 60, 5 * 60, 15 * 60, 30 * 60, 60 * 60, 2 * 3600];

export interface SlipResult {
  outcome: SlipDecision["outcome"];
  reason: string | null;
}

type Decision = SlipDecision & { slip?: VerifiedSlip; retryAfterSeconds?: number; provider: string; raw?: unknown };

/**
 * Automatic slip verification. A slip is read back from the bank network through a
 * verification provider, then matched against the payment (amount, receiver, date) and
 * against every slip already used, before the payment is marked paid.
 */
export class SlipService {
  private retrying = false;

  constructor(
    private readonly db: Db,
    private readonly payments: PaymentService,
    private readonly merchants: MerchantService,
    private readonly verifiers: { test: SlipVerifier; live: SlipVerifier | null },
  ) {}

  /** Handles a slip uploaded from the checkout page. */
  async submit(id: string, mime: string, data: Buffer): Promise<{ payment: PaymentRow; result: SlipResult }> {
    const found = this.payments.get(id);
    if (!found) throw new PaymentError(404, "not_found", "Payment not found");
    const p = this.payments.expireIfDue(found);
    if (p.method === "card") throw new PaymentError(400, "invalid_method", "Slips are only for PromptPay and bank transfer");
    if (p.status !== "pending") throw new PaymentError(409, "invalid_state", `Payment is already ${p.status}`);
    const ext = SLIP_MIME_TYPES[mime];
    if (!ext) throw new PaymentError(400, "invalid_file", "Slip must be a JPEG, PNG, WebP or PDF file");

    // Take the verification lock; this also stops two uploads for one payment racing each other.
    const locked = this.db
      .prepare(
        `UPDATE payments SET verify_status = 'verifying', verify_started_at = ?, slip_attempts = slip_attempts + 1
         WHERE id = ? AND status = 'pending' AND slip_attempts < ?
           AND (verify_status IS NOT 'verifying' OR verify_started_at < ?)`,
      )
      .run(now(), p.id, MAX_SLIP_ATTEMPTS, verificationLockCutoff());
    if (locked.changes === 0) {
      const cur = this.payments.get(p.id)!;
      if (cur.status !== "pending") throw new PaymentError(409, "invalid_state", `Payment is already ${cur.status}`);
      if (cur.slip_attempts >= MAX_SLIP_ATTEMPTS) {
        throw new PaymentError(429, "too_many_attempts", "Too many slip uploads for this payment; please contact the merchant");
      }
      throw new PaymentError(409, "verification_in_progress", "A slip for this payment is already being checked");
    }

    try {
      fs.mkdirSync(this.payments.slipDir, { recursive: true });
      const file = `${p.id}${ext}`;
      fs.writeFileSync(path.join(this.payments.slipDir, file), data);
      this.db.prepare("UPDATE payments SET slip_path = ?, slip_mime = ? WHERE id = ?").run(file, mime, p.id);

      const decision = await this.decide(p, mime, data);
      return this.apply(p.id, decision, false);
    } finally {
      // Never leave the lock behind, whatever happened above.
      this.db
        .prepare("UPDATE payments SET verify_status = NULL WHERE id = ? AND verify_status = 'verifying'")
        .run(p.id);
    }
  }

  /** Re-checks slips the bank could not confirm at upload time (bank delay, provider outage). */
  async retryDue(limit = 20): Promise<number> {
    if (this.retrying) return 0;
    this.retrying = true;
    try {
      return await this.retryDueOnce(limit);
    } finally {
      this.retrying = false;
    }
  }

  private async retryDueOnce(limit: number): Promise<number> {
    const due = this.db
      .prepare(
        `SELECT * FROM payments WHERE status = 'awaiting_review' AND verify_status = 'needs_review'
         AND verify_retry_at IS NOT NULL AND verify_retry_at <= ? ORDER BY verify_retry_at LIMIT ?`,
      )
      .all(now(), limit) as unknown as PaymentRow[];
    for (const p of due) {
      const slip = this.payments.readSlip(p);
      if (!slip) continue;
      this.db.prepare("UPDATE payments SET verify_retries = verify_retries + 1, verify_retry_at = NULL WHERE id = ?").run(p.id);
      this.apply(p.id, await this.decide(p, slip.mime, slip.data), true);
    }
    return due.length;
  }

  private async decide(p: PaymentRow, mime: string, data: Buffer): Promise<Decision> {
    const merchant = this.merchants.get(p.merchant_id)!;
    const verifier = p.livemode === 1 ? this.verifiers.live : this.verifiers.test;
    if (!verifier) return { outcome: "needs_review", reason: "verifier_not_configured", provider: "none" };
    if (mime === "application/pdf") return { outcome: "needs_review", reason: "pdf_not_verifiable", provider: verifier.name };

    let check;
    try {
      check = await verifier.check(data, mime, {
        amount: p.amount,
        receiverProxy: p.method === "promptpay" ? merchant.promptpay_id : null,
        receiverAccount: p.method === "bank_transfer" ? merchant.bank_account_no : null,
      });
    } catch (err) {
      return {
        outcome: "needs_review",
        reason: "verifier_unreachable",
        retryAfterSeconds: RETRY_DELAYS_S[0],
        provider: verifier.name,
        raw: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    if (check.kind === "invalid") return { outcome: "rejected", reason: check.reason, provider: verifier.name };
    if (check.kind === "retry") {
      return {
        outcome: "needs_review",
        reason: check.reason,
        retryAfterSeconds: check.retryAfterSeconds ?? RETRY_DELAYS_S[0],
        provider: verifier.name,
      };
    }
    const decision = evaluateSlip(check.slip, {
      method: p.method as "promptpay" | "bank_transfer",
      amount: p.amount,
      createdAt: p.created_at,
      promptpayId: merchant.promptpay_id,
      bankAccountNo: merchant.bank_account_no,
    });
    return { ...decision, slip: check.slip, provider: verifier.name, raw: check.slip.raw };
  }

  /**
   * Records a decision and moves the payment accordingly.
   * @param isRetry the payment is already awaiting review (background re-check) rather than pending
   */
  private apply(id: string, d: Decision, isRetry: boolean): { payment: PaymentRow; result: SlipResult } {
    let decision: Decision = d;

    if (decision.outcome === "verified" && decision.slip) {
      const slip = decision.slip;
      try {
        const payment = this.payments.transition(id, "succeeded", {
          confirmed_by: "slip",
          before: () => {
            const used = this.db.prepare("SELECT payment_id FROM used_slips WHERE trans_ref = ?").get(slip.transRef) as
              | { payment_id: string }
              | undefined;
            if (used && used.payment_id !== id) throw new DuplicateSlip();
            if (!used) {
              this.db
                .prepare("INSERT INTO used_slips (trans_ref, payment_id, created_at) VALUES (?, ?, ?)")
                .run(slip.transRef, id, now());
            }
            this.db
              .prepare(
                `UPDATE payments SET verify_status = 'verified', verify_reason = NULL, verify_retry_at = NULL,
                   slip_trans_ref = ? WHERE id = ?`,
              )
              .run(slip.transRef, id);
          },
        });
        this.log(id, decision);
        return { payment, result: { outcome: "verified", reason: null } };
      } catch (err) {
        if (err instanceof DuplicateSlip) {
          decision = { ...decision, outcome: "rejected", reason: "duplicate_slip" };
        } else if (err instanceof PaymentError && err.code === "invalid_state") {
          // The payment moved on meanwhile (e.g. merchant approved or cancelled it); keep its state.
          this.log(id, { ...decision, outcome: "needs_review", reason: "payment_state_changed" });
          return { payment: this.payments.get(id)!, result: { outcome: "needs_review", reason: "payment_state_changed" } };
        } else {
          throw err;
        }
      }
    }

    this.log(id, decision);
    const reason = "reason" in decision ? decision.reason : null;

    if (decision.outcome === "rejected") {
      this.db
        .prepare("UPDATE payments SET verify_status = 'rejected', verify_reason = ?, verify_retry_at = NULL, updated_at = ? WHERE id = ?")
        .run(reason, now(), id);
      const payment = this.payments.get(id)!;
      this.payments.emitEvent(payment, "payment.slip_rejected");
      return { payment, result: { outcome: "rejected", reason } };
    }

    // needs_review: hand to the merchant, and keep re-checking in the background if it may resolve itself.
    const current = this.payments.get(id)!;
    const retries = current.verify_retries;
    const retryAt =
      decision.retryAfterSeconds !== undefined && retries < MAX_VERIFY_RETRIES
        ? new Date(Date.now() + Math.max(decision.retryAfterSeconds, RETRY_DELAYS_S[retries] ?? 0) * 1000).toISOString()
        : null;
    const mark = () =>
      this.db
        .prepare("UPDATE payments SET verify_status = 'needs_review', verify_reason = ?, verify_retry_at = ? WHERE id = ?")
        .run(reason, retryAt, id);
    if (isRetry) {
      mark();
      return { payment: this.payments.get(id)!, result: { outcome: "needs_review", reason } };
    }
    return { payment: this.payments.transition(id, "awaiting_review", { before: mark }), result: { outcome: "needs_review", reason } };
  }

  private log(paymentId: string, d: Decision): void {
    this.db
      .prepare(
        `INSERT INTO slip_checks (id, payment_id, provider, outcome, reason, trans_ref, amount, raw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("slc"),
        paymentId,
        d.provider,
        d.outcome,
        "reason" in d ? d.reason : null,
        d.slip?.transRef ?? null,
        d.slip?.amount ?? null,
        d.raw === undefined ? null : JSON.stringify(d.raw),
        now(),
      );
  }

  history(paymentId: string) {
    return this.db
      .prepare(
        "SELECT id, provider, outcome, reason, trans_ref, amount, created_at FROM slip_checks WHERE payment_id = ? ORDER BY created_at",
      )
      .all(paymentId);
  }
}

class DuplicateSlip extends Error {}
