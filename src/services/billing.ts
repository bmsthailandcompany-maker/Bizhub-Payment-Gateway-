import type { Db } from "../db.ts";
import { now, tx } from "../db.ts";
import { newId } from "../ids.ts";
import type { MerchantRow, MerchantService } from "./merchants.ts";
import { PaymentError, type PaymentRow, type PaymentService } from "./payments.ts";

export interface PlanRow {
  id: string;
  name: string;
  monthly_fee: number;
  included_transactions: number;
  per_transaction_fee: number;
  percent_fee_bps: number;
  active: number;
  created_at: string;
}

export interface InvoiceRow {
  id: string;
  number: string;
  merchant_id: string;
  period: string;
  plan_snapshot: string;
  transaction_count: number;
  volume: number;
  monthly_fee: number;
  usage_fee: number;
  percent_fee: number;
  subtotal: number;
  vat_rate_bps: number;
  vat: number;
  total: number;
  status: "issued" | "paid" | "void";
  payment_id: string | null;
  issued_at: string;
  due_at: string;
  paid_at: string | null;
}

export interface BillingConfig {
  /** VAT in basis points (700 = 7%). */
  vatRateBps: number;
  dueDays: number;
  /** The operator's own shop on this gateway; invoices are paid to it through a normal payment. */
  billingMerchantId: string | null;
  issuer: { name: string; taxId: string | null; address: string | null };
}

const BKK_MS = 7 * 3600_000;

/** "2026-10" for the Thai calendar month containing `t`. */
export function bangkokMonth(t = Date.now()): string {
  return new Date(t + BKK_MS).toISOString().slice(0, 7);
}

export function previousMonth(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** [start, end) of a Thai calendar month as ISO timestamps. */
export function monthRange(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const start = Date.UTC(y, m - 1, 1) - BKK_MS;
  const end = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - BKK_MS;
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

export interface Charges {
  transaction_count: number;
  volume: number;
  monthly_fee: number;
  usage_fee: number;
  percent_fee: number;
  subtotal: number;
  vat: number;
  total: number;
}

/** The hybrid price for one month of usage. Pure, so the dashboard estimate and the invoice always agree. */
export function computeCharges(plan: Pick<PlanRow, "monthly_fee" | "included_transactions" | "per_transaction_fee" | "percent_fee_bps">, usage: { count: number; volume: number }, vatRateBps: number): Charges {
  const extra = Math.max(0, usage.count - plan.included_transactions);
  const usageFee = extra * plan.per_transaction_fee;
  const percentFee = Math.round((usage.volume * plan.percent_fee_bps) / 10_000);
  const subtotal = plan.monthly_fee + usageFee + percentFee;
  const vat = Math.round((subtotal * vatRateBps) / 10_000);
  return { transaction_count: usage.count, volume: usage.volume, monthly_fee: plan.monthly_fee, usage_fee: usageFee, percent_fee: percentFee, subtotal, vat, total: subtotal + vat };
}

export function serializePlan(p: PlanRow) {
  return {
    id: p.id,
    name: p.name,
    monthly_fee: p.monthly_fee,
    included_transactions: p.included_transactions,
    per_transaction_fee: p.per_transaction_fee,
    percent_fee_bps: p.percent_fee_bps,
    active: p.active === 1,
    created_at: p.created_at,
  };
}

/**
 * Plans, monthly usage and invoices. A billable transaction is a live payment that succeeded
 * during the month. Invoices are paid like any customer payment, to the operator's own shop,
 * and flip to paid when that payment succeeds.
 */
export class BillingService {
  constructor(
    private readonly db: Db,
    private readonly merchants: MerchantService,
    private readonly payments: PaymentService,
    private readonly cfg: BillingConfig,
  ) {
    payments.onSucceeded((p) => this.markPaidByPayment(p));
  }

  get config(): BillingConfig {
    return this.cfg;
  }

  // ---- plans ----
  plans(includeArchived = true): PlanRow[] {
    return this.db
      .prepare(`SELECT * FROM plans ${includeArchived ? "" : "WHERE active = 1"} ORDER BY monthly_fee, created_at`)
      .all() as unknown as PlanRow[];
  }

  plan(id: string): PlanRow | undefined {
    return this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
  }

  createPlan(input: Omit<PlanRow, "id" | "active" | "created_at">): PlanRow {
    const id = newId("plan");
    this.db
      .prepare(
        "INSERT INTO plans (id, name, monthly_fee, included_transactions, per_transaction_fee, percent_fee_bps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.name, input.monthly_fee, input.included_transactions, input.per_transaction_fee, input.percent_fee_bps, now());
    return this.plan(id)!;
  }

  /** Price changes apply from the next invoice; issued invoices keep the plan they were issued on. */
  updatePlan(id: string, input: Partial<Omit<PlanRow, "id" | "created_at" | "active">> & { active?: boolean }): PlanRow {
    const p = this.plan(id);
    if (!p) throw new PaymentError(404, "not_found", "ไม่พบแพ็กเกจ");
    const n = { ...p, ...input, active: input.active === undefined ? p.active : input.active ? 1 : 0 };
    this.db
      .prepare("UPDATE plans SET name = ?, monthly_fee = ?, included_transactions = ?, per_transaction_fee = ?, percent_fee_bps = ?, active = ? WHERE id = ?")
      .run(n.name, n.monthly_fee, n.included_transactions, n.per_transaction_fee, n.percent_fee_bps, n.active, id);
    return this.plan(id)!;
  }

  assignPlan(merchantId: string, planId: string | null): void {
    if (planId) {
      const p = this.plan(planId);
      if (!p || p.active !== 1) throw new PaymentError(400, "invalid_plan", "แพ็กเกจนี้ใช้ไม่ได้");
    }
    this.db.prepare("UPDATE merchants SET plan_id = ? WHERE id = ?").run(planId, merchantId);
  }

  // ---- usage ----
  usage(merchantId: string, period: string): { count: number; volume: number } {
    const { from, to } = monthRange(period);
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS volume FROM payments
         WHERE merchant_id = ? AND livemode = 1 AND status = 'succeeded' AND paid_at >= ? AND paid_at < ?`,
      )
      .get(merchantId, from, to) as { count: number; volume: number };
    return { count: r.count, volume: r.volume };
  }

  /** What the shop would owe for `period` on its current plan (for the dashboard). */
  estimate(m: MerchantRow, period = bangkokMonth()) {
    const plan = m.plan_id ? this.plan(m.plan_id) : undefined;
    if (!plan) return null;
    return { period, plan: serializePlan(plan), ...computeCharges(plan, this.usage(m.id, period), this.cfg.vatRateBps) };
  }

  // ---- invoices ----
  invoice(id: string): InvoiceRow | undefined {
    return this.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow | undefined;
  }

  invoices(filter: { merchantId?: string; status?: string; period?: string }, limit = 100): (InvoiceRow & { merchant_name: string })[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.merchantId) (where.push("i.merchant_id = ?"), args.push(filter.merchantId));
    if (filter.status) (where.push("i.status = ?"), args.push(filter.status));
    if (filter.period) (where.push("i.period = ?"), args.push(filter.period));
    return this.db
      .prepare(
        `SELECT i.*, m.name AS merchant_name FROM invoices i JOIN merchants m ON m.id = i.merchant_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.period DESC, i.number DESC LIMIT ?`,
      )
      .all(...args, limit) as unknown as (InvoiceRow & { merchant_name: string })[];
  }

  private nextNumber(period: string): string {
    const prefix = `INV-${period.replace("-", "")}-`;
    const last = this.db.prepare("SELECT number FROM invoices WHERE number LIKE ? ORDER BY number DESC LIMIT 1").get(prefix + "%") as
      | { number: string }
      | undefined;
    const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
    return prefix + String(seq).padStart(4, "0");
  }

  /** Issues the invoice for one shop and month; returns the existing one if already issued. */
  issue(merchantId: string, period: string): InvoiceRow | null {
    const existing = this.db.prepare("SELECT * FROM invoices WHERE merchant_id = ? AND period = ?").get(merchantId, period) as InvoiceRow | undefined;
    if (existing) return existing;
    const m = this.merchants.get(merchantId);
    const plan = m?.plan_id ? this.plan(m.plan_id) : undefined;
    if (!m || !plan) return null;
    if (period >= bangkokMonth()) throw new PaymentError(400, "period_open", "ออกใบแจ้งหนี้ได้เฉพาะเดือนที่จบแล้ว");

    const c = computeCharges(plan, this.usage(m.id, period), this.cfg.vatRateBps);
    const id = newId("inv");
    const issuedAt = now();
    const dueAt = new Date(Date.now() + this.cfg.dueDays * 86400_000).toISOString();
    const number = tx(this.db, () => {
      const n = this.nextNumber(period);
      this.db
        .prepare(
          `INSERT INTO invoices (id, number, merchant_id, period, plan_snapshot, transaction_count, volume, monthly_fee, usage_fee, percent_fee,
             subtotal, vat_rate_bps, vat, total, status, issued_at, due_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, n, m.id, period, JSON.stringify(serializePlan(plan)), c.transaction_count, c.volume, c.monthly_fee, c.usage_fee, c.percent_fee,
          c.subtotal, this.cfg.vatRateBps, c.vat, c.total, c.total === 0 ? "paid" : "issued", issuedAt, dueAt);
      if (c.total === 0) this.db.prepare("UPDATE invoices SET paid_at = ? WHERE id = ?").run(issuedAt, id);
      return n;
    });
    if (c.total > 0) this.attachPayment(id, number, c.total, dueAt);
    return this.invoice(id)!;
  }

  /** The invoice is paid through the operator's own shop, like any customer payment. */
  private attachPayment(invoiceId: string, number: string, total: number, dueAt: string): void {
    const billing = this.cfg.billingMerchantId ? this.merchants.get(this.cfg.billingMerchantId) : undefined;
    if (!billing || (!billing.promptpay_id && !billing.bank_account_no)) return;
    const ttl = Math.max(3600, Math.min(30 * 86400, Math.round((Date.parse(dueAt) - Date.now()) / 1000) + 7 * 86400));
    const p = this.payments.create(billing, true, {
      amount: total,
      currency: "THB",
      method: billing.promptpay_id ? "promptpay" : "bank_transfer",
      reference: number,
      description: "ค่าบริการ Bizhub " + number,
      metadata: { invoice_id: invoiceId },
      expires_in: Math.min(ttl, 7 * 86400),
    });
    this.db.prepare("UPDATE invoices SET payment_id = ? WHERE id = ?").run(p.id, invoiceId);
  }

  /** A working payment link for an unpaid invoice, replacing one that expired. */
  payLink(id: string): string {
    const inv = this.invoice(id);
    if (!inv) throw new PaymentError(404, "not_found", "ไม่พบใบแจ้งหนี้");
    if (inv.status !== "issued") throw new PaymentError(409, "invalid_state", "ใบแจ้งหนี้นี้ชำระแล้วหรือถูกยกเลิก");
    const current = inv.payment_id ? this.payments.get(inv.payment_id) : undefined;
    const live = current ? this.payments.expireIfDue(current) : undefined;
    if (!live || live.status !== "pending") this.attachPayment(inv.id, inv.number, inv.total, inv.due_at);
    const fresh = this.invoice(id)!;
    const p = fresh.payment_id ? this.payments.get(fresh.payment_id) : undefined;
    if (!p) throw new PaymentError(503, "billing_not_configured", "ยังไม่ได้ตั้งบัญชีรับชำระค่าบริการ กรุณาติดต่อผู้ให้บริการ");
    return this.payments.serialize(p).checkout_url;
  }

  private markPaidByPayment(p: PaymentRow): void {
    const inv = this.db.prepare("SELECT * FROM invoices WHERE payment_id = ? AND status = 'issued'").get(p.id) as InvoiceRow | undefined;
    if (inv) this.db.prepare("UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?").run(now(), inv.id);
  }

  /** Staff record a payment received outside the gateway, or cancel an invoice issued in error. */
  setStatus(id: string, status: "paid" | "void"): InvoiceRow {
    const inv = this.invoice(id);
    if (!inv) throw new PaymentError(404, "not_found", "ไม่พบใบแจ้งหนี้");
    if (inv.status !== "issued") throw new PaymentError(409, "invalid_state", "เปลี่ยนสถานะได้เฉพาะใบแจ้งหนี้ที่ยังไม่ชำระ");
    this.db.prepare("UPDATE invoices SET status = ?, paid_at = ? WHERE id = ?").run(status, status === "paid" ? now() : null, id);
    return this.invoice(id)!;
  }

  /** Issues last month's invoices for every billed shop that does not have one yet. Safe to call often. */
  runMonthly(): number {
    const period = previousMonth(bangkokMonth());
    const due = this.db
      .prepare(
        `SELECT m.id FROM merchants m WHERE m.plan_id IS NOT NULL AND m.kyc_status = 'approved'
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.merchant_id = m.id AND i.period = ?)`,
      )
      .all(period) as { id: string }[];
    for (const r of due) this.issue(r.id, period);
    return due.length;
  }

  serializeInvoice(i: InvoiceRow & { merchant_name?: string }) {
    const payment = i.payment_id ? this.payments.get(i.payment_id) : undefined;
    return {
      id: i.id,
      number: i.number,
      merchant_id: i.merchant_id,
      merchant_name: i.merchant_name,
      period: i.period,
      plan: JSON.parse(i.plan_snapshot),
      transaction_count: i.transaction_count,
      volume: i.volume,
      monthly_fee: i.monthly_fee,
      usage_fee: i.usage_fee,
      percent_fee: i.percent_fee,
      subtotal: i.subtotal,
      vat_rate_bps: i.vat_rate_bps,
      vat: i.vat,
      total: i.total,
      status: i.status,
      pay_url: i.status === "issued" && payment && payment.status === "pending" ? this.payments.serialize(payment).checkout_url : null,
      issued_at: i.issued_at,
      due_at: i.due_at,
      paid_at: i.paid_at,
    };
  }
}
