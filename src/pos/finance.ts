/**
 * Phase 1 POS financial rules. Pure functions: no gateway calls, no production mutations.
 * All money amounts are integer satang. A merchant owns every order and ledger entry.
 */
export type Tender = "cash" | "promptpay_manual" | "promptpay_verified" | "card";
export type OrderLine = { productId: string; quantity: number; unitPriceSatang: number; unitCostSatang?: number };
export type OrderTotals = { subtotalSatang: number; costSatang: number; discountSatang: number; totalSatang: number };
export type LedgerEntry = { merchantId: string; orderId?: string; kind: "income" | "expense"; amountSatang: number; category: string; recordedAt: string };
export type OrderPayment = { merchantId: string; orderId: string; tender: Tender; amountSatang: number; status: "pending" | "confirmed"; providerReference?: string };
const validMoney = (v: number): boolean => Number.isSafeInteger(v) && v >= 0;
export function calculateOrder(lines: readonly OrderLine[], discountSatang = 0): OrderTotals {
  if (!lines.length) throw new Error("order requires at least one line");
  if (!validMoney(discountSatang)) throw new Error("invalid discount");
  let subtotalSatang = 0, costSatang = 0;
  for (const line of lines) {
    if (!line.productId || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 || !validMoney(line.unitPriceSatang) || (line.unitCostSatang !== undefined && !validMoney(line.unitCostSatang))) throw new Error("invalid order line");
    subtotalSatang += line.quantity * line.unitPriceSatang;
    costSatang += line.quantity * (line.unitCostSatang ?? 0);
    if (!Number.isSafeInteger(subtotalSatang) || !Number.isSafeInteger(costSatang)) throw new Error("amount overflow");
  }
  if (discountSatang > subtotalSatang) throw new Error("discount exceeds subtotal");
  return { subtotalSatang, costSatang, discountSatang, totalSatang: subtotalSatang - discountSatang };
}
export function validatePaymentForOrder(merchantId: string, orderId: string, totalSatang: number, payment: OrderPayment): void {
  if (!merchantId || !orderId || payment.merchantId !== merchantId || payment.orderId !== orderId) throw new Error("merchant/order mismatch");
  if (!validMoney(totalSatang) || !validMoney(payment.amountSatang) || payment.amountSatang !== totalSatang) throw new Error("payment amount mismatch");
  // Static merchant QR is not bank confirmation. Never automatically confirm it.
  if (payment.tender === "promptpay_manual" && payment.status === "confirmed") throw new Error("manual PromptPay requires explicit staff confirmation workflow");
  if (payment.tender === "promptpay_verified" && payment.status === "confirmed" && !payment.providerReference) throw new Error("verified payment requires provider reference");
}
export function summarizeLedger(merchantId: string, entries: readonly LedgerEntry[]): { incomeSatang: number; expenseSatang: number; netSatang: number } {
  if (!merchantId) throw new Error("merchant required");
  let incomeSatang = 0, expenseSatang = 0;
  for (const entry of entries) {
    if (entry.merchantId !== merchantId) throw new Error("cross-merchant ledger entry");
    if (!validMoney(entry.amountSatang)) throw new Error("invalid ledger amount");
    if (entry.kind === "income") incomeSatang += entry.amountSatang;
    else if (entry.kind === "expense") expenseSatang += entry.amountSatang;
    else throw new Error("invalid ledger kind");
    if (!Number.isSafeInteger(incomeSatang) || !Number.isSafeInteger(expenseSatang)) throw new Error("amount overflow");
  }
  return { incomeSatang, expenseSatang, netSatang: incomeSatang - expenseSatang };
}
