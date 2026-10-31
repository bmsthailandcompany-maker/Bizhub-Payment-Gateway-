import type { BillingConfig } from "../services/billing.ts";
import type { MerchantRow } from "../services/merchants.ts";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const baht = (satang: number) => (satang / 100).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const thaiDate = (iso: string) => new Date(iso).toLocaleDateString("th-TH", { dateStyle: "long", timeZone: "Asia/Bangkok" });

export const INVOICE_DOC_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

/** Printable invoice (ใบแจ้งหนี้). A full Thai tax invoice needs the buyer's address, which shops do not provide yet. */
export function renderInvoiceDocument(
  inv: ReturnType<import("../services/billing.ts").BillingService["serializeInvoice"]>,
  merchant: MerchantRow,
  issuer: BillingConfig["issuer"],
): string {
  const plan = inv.plan as { name: string; included_transactions: number; per_transaction_fee: number; percent_fee_bps: number };
  const extra = Math.max(0, inv.transaction_count - plan.included_transactions);
  const [y, m] = inv.period.split("-").map(Number) as [number, number];
  const monthName = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("th-TH", { month: "long", year: "numeric", timeZone: "Asia/Bangkok" });
  const rows: [string, string, number][] = [[`ค่าบริการรายเดือน แพ็กเกจ ${plan.name} (${monthName})`, "1", inv.monthly_fee]];
  if (inv.usage_fee) rows.push([`รายการเกินแพ็กเกจ (${inv.transaction_count} รายการ, รวมในแพ็กเกจ ${plan.included_transactions})`, `${extra} × ${baht(plan.per_transaction_fee)}`, inv.usage_fee]);
  if (inv.percent_fee) rows.push([`ค่าธรรมเนียม ${(plan.percent_fee_bps / 100).toFixed(2)}% ของยอดรับชำระ ${baht(inv.volume)} บาท`, "", inv.percent_fee]);
  const status = { issued: "รอชำระ", paid: "ชำระแล้ว", void: "ยกเลิก" }[inv.status];
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ใบแจ้งหนี้ ${esc(inv.number)}</title>
<style>
  body{margin:0;background:#eef0f3;font:15px/1.6 system-ui,"Noto Sans Thai",sans-serif;color:#1d2330}
  .page{max-width:800px;margin:24px auto;background:#fff;padding:40px;border-radius:8px}
  header{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;border-bottom:2px solid #1d2330;padding-bottom:16px}
  h1{margin:0;font-size:26px} .muted{color:#667085} .right{text-align:right}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:24px 0} .parties h3{margin:0 0 4px;font-size:13px;color:#667085;font-weight:600}
  table{width:100%;border-collapse:collapse} th,td{padding:10px 8px;border-bottom:1px solid #e4e7ec;text-align:left;vertical-align:top}
  th{font-size:12px;color:#667085} td.n,th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  .totals td{border:0;padding:4px 8px} .grand td{font-size:18px;font-weight:700;border-top:2px solid #1d2330;padding-top:10px}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:600;background:${inv.status === "paid" ? "#e7f6ec;color:#067647" : inv.status === "void" ? "#fdecea;color:#b42318" : "#fef3e2;color:#b54708"}}
  @media print{body{background:#fff}.page{margin:0;border-radius:0}}
  @media (max-width:600px){.page{padding:20px}.parties{grid-template-columns:1fr}}
</style></head><body><div class="page">
<header><div><h1>ใบแจ้งหนี้</h1><div class="muted">Invoice</div></div>
<div class="right"><div><b>${esc(inv.number)}</b></div><div class="muted">ออกวันที่ ${thaiDate(inv.issued_at)}</div><div class="muted">ครบกำหนด ${thaiDate(inv.due_at)}</div><div><span class="badge">${status}</span></div></div></header>
<div class="parties">
  <div><h3>ผู้ให้บริการ</h3><b>${esc(issuer.name)}</b>${issuer.address ? `<div>${esc(issuer.address)}</div>` : ""}${issuer.taxId ? `<div>เลขประจำตัวผู้เสียภาษี ${esc(issuer.taxId)}</div>` : ""}</div>
  <div><h3>ลูกค้า</h3><b>${esc(merchant.name)}</b>${merchant.tax_id ? `<div>เลขประจำตัวผู้เสียภาษี ${esc(merchant.tax_id)}</div>` : ""}<div class="muted">รหัสร้าน ${esc(merchant.id)}</div></div>
</div>
<table><thead><tr><th>รายการ</th><th class="n">จำนวน</th><th class="n">จำนวนเงิน (บาท)</th></tr></thead><tbody>
${rows.map(([d, q, a]) => `<tr><td>${esc(d)}</td><td class="n">${esc(q)}</td><td class="n">${baht(a)}</td></tr>`).join("")}
</tbody></table>
<table class="totals"><tbody>
<tr><td></td><td class="n">รวมก่อนภาษี</td><td class="n" style="width:160px">${baht(inv.subtotal)}</td></tr>
<tr><td></td><td class="n">ภาษีมูลค่าเพิ่ม ${(inv.vat_rate_bps / 100).toFixed(0)}%</td><td class="n">${baht(inv.vat)}</td></tr>
<tr class="grand"><td></td><td class="n">ยอดชำระ</td><td class="n">${baht(inv.total)}</td></tr>
</tbody></table>
${inv.paid_at ? `<p class="muted">ชำระเมื่อ ${thaiDate(inv.paid_at)}</p>` : ""}
<p class="muted" style="margin-top:32px;font-size:13px">เอกสารนี้เป็นใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี · สั่งพิมพ์หรือบันทึกเป็น PDF ได้จากเมนูพิมพ์ของเบราว์เซอร์</p>
</div></body></html>`;
}
