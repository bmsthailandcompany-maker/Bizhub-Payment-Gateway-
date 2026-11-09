import assert from "node:assert/strict";
import test from "node:test";
import { calculateOrder, summarizeLedger, validatePaymentForOrder } from "../src/pos/finance.ts";
test("order calculation uses integer satang and discount", () => {
  assert.deepEqual(calculateOrder([{ productId: "coffee", quantity: 2, unitPriceSatang: 6500, unitCostSatang: 2500 }], 1000), { subtotalSatang: 13000, costSatang: 5000, discountSatang: 1000, totalSatang: 12000 });
});
test("reject invalid quantity and excessive discount", () => {
  assert.throws(() => calculateOrder([{ productId: "x", quantity: 0, unitPriceSatang: 100 }]));
  assert.throws(() => calculateOrder([{ productId: "x", quantity: 1, unitPriceSatang: 100 }], 101));
});
test("never treat uploaded static QR as automatically confirmed", () => {
  assert.throws(() => validatePaymentForOrder("a", "o", 100, { merchantId: "a", orderId: "o", amountSatang: 100, tender: "promptpay_manual", status: "confirmed" }));
});
test("verified payment requires provider evidence and matching merchant", () => {
  assert.throws(() => validatePaymentForOrder("a", "o", 100, { merchantId: "b", orderId: "o", amountSatang: 100, tender: "promptpay_verified", status: "confirmed", providerReference: "ref" }));
  assert.throws(() => validatePaymentForOrder("a", "o", 100, { merchantId: "a", orderId: "o", amountSatang: 100, tender: "promptpay_verified", status: "confirmed" }));
  assert.doesNotThrow(() => validatePaymentForOrder("a", "o", 100, { merchantId: "a", orderId: "o", amountSatang: 100, tender: "promptpay_verified", status: "confirmed", providerReference: "ref" }));
});
test("ledger excludes other merchants and calculates net", () => {
  assert.deepEqual(summarizeLedger("a", [{ merchantId: "a", kind: "income", amountSatang: 5000, category: "sales", recordedAt: "2026-11-02" }, { merchantId: "a", kind: "expense", amountSatang: 1200, category: "supplies", recordedAt: "2026-11-02" }]), { incomeSatang: 5000, expenseSatang: 1200, netSatang: 3800 });
  assert.throws(() => summarizeLedger("a", [{ merchantId: "b", kind: "income", amountSatang: 100, category: "sales", recordedAt: "2026-11-02" }]));
});
