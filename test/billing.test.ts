import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Gateway } from "../src/app.ts";
import { bangkokMonth, computeCharges, monthRange, previousMonth } from "../src/services/billing.ts";
import { ADMIN, type Call, createMerchant, makeGateway, staff, webLogin } from "./helpers.ts";

let gw: Gateway;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

test("hybrid price: monthly fee + per extra transaction + percentage, VAT on top, all in satang", () => {
  const plan = { monthly_fee: 49000, included_transactions: 300, per_transaction_fee: 200, percent_fee_bps: 50 };
  const c = computeCharges(plan, { count: 350, volume: 10_000_000 }, 700);
  assert.deepEqual(c, { transaction_count: 350, volume: 10_000_000, monthly_fee: 49000, usage_fee: 50 * 200, percent_fee: 50_000, subtotal: 109_000, vat: 7630, total: 116_630 });
  assert.equal(computeCharges(plan, { count: 10, volume: 0 }, 700).usage_fee, 0, "nothing extra within the included quota");
});

test("months follow the Thai calendar", () => {
  assert.equal(previousMonth("2026-01"), "2025-12");
  assert.deepEqual(monthRange("2026-10"), { from: "2026-09-30T17:00:00.000Z", to: "2026-10-31T17:00:00.000Z" });
});

async function setup() {
  ({ gw, cleanup } = await makeGateway({}, {
    billing: { vatRateBps: 700, dueDays: 7, billingMerchantId: null, issuer: { name: "บริษัท บิซฮับ จำกัด", taxId: "0105555000000", address: "กรุงเทพฯ" } },
  }));
  // The operator's own shop receives invoice payments.
  const op = await createMerchant(gw, "Bizhub (ผู้ให้บริการ)");
  (gw.billing.config as { billingMerchantId: string | null }).billingMerchantId = op.id;
  const shop = await createMerchant(gw, "ร้านลูกค้า");
  const root = await webLogin(gw, "admin", { admin_token: ADMIN });
  return { op, shop, root };
}

function seedPaid(shopId: string, period: string, n: number, amount: number, live = 1) {
  const { from } = monthRange(period);
  const t = new Date(Date.parse(from) + 3 * 86400_000).toISOString();
  const ins = gw.db.prepare(
    `INSERT INTO payments (id, merchant_id, livemode, amount, currency, method, status, expires_at, paid_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'THB', 'promptpay', 'succeeded', ?, ?, ?, ?)`,
  );
  for (let i = 0; i < n; i++) ins.run(`pay_seed_${period}_${live}_${i}`, shopId, live, amount, t, t, t, t);
}

test("monthly invoices: usage counted from live paid payments, numbered, VAT, paid through the operator's own shop", async () => {
  const { op, shop, root } = await setup();
  const plan = (await root("POST", "/plans", { name: "Starter", monthly_fee: 49000, included_transactions: 2, per_transaction_fee: 300, percent_fee_bps: 100 })).json();
  assert.equal((await root("POST", `/merchants/${shop.id}/plan`, { plan_id: plan.id })).statusCode, 200);
  const last = previousMonth(bangkokMonth());
  seedPaid(shop.id, last, 5, 10000);
  seedPaid(shop.id, last, 3, 99900, 0); // test-mode payments are never billed
  seedPaid(shop.id, bangkokMonth(), 1, 10000); // this month belongs to the next invoice

  const gen = await root("POST", "/invoices/generate", {});
  assert.deepEqual(gen.json(), { period: last, issued: 1 });
  assert.equal((await root("POST", "/invoices/generate", {})).json().issued, 0, "idempotent");
  const inv = (await root("GET", "/invoices")).json().data[0];
  assert.match(inv.number, new RegExp(`^INV-${last.replace("-", "")}-0001$`));
  assert.equal(inv.transaction_count, 5);
  assert.equal(inv.usage_fee, 3 * 300);
  assert.equal(inv.percent_fee, 500); // 1% of 500 baht
  assert.equal(inv.subtotal, 49000 + 900 + 500);
  assert.equal(inv.vat, Math.round(50400 * 0.07));
  assert.equal(inv.status, "issued");
  assert.ok(inv.pay_url);

  // Editing the plan later never changes an issued invoice.
  await root("PATCH", `/plans/${plan.id}`, { monthly_fee: 99000 });
  assert.equal((await root("GET", "/invoices")).json().data[0].monthly_fee, 49000);

  // The shop's accountant sees it; a cashier does not.
  const owner = await webLogin(gw, "dashboard", { secret_key: shop.live_secret_key });
  const accountant = await staff(gw, owner, "accountant", "acc@shop.th");
  const cashier = await staff(gw, owner, "cashier", "c@shop.th");
  assert.equal((await cashier("GET", "/billing")).statusCode, 403);
  const view = (await accountant("GET", "/billing")).json();
  assert.equal(view.invoices[0].number, inv.number);
  assert.equal(view.current.transaction_count, 1, "this month's running usage");
  const doc = await accountant("GET", `/invoices/${inv.id}/document`);
  assert.match(doc.body, /ใบแจ้งหนี้/);
  assert.match(doc.body, /บริษัท บิซฮับ จำกัด/);

  // Paying the invoice is an ordinary payment to the operator's shop; once it succeeds the invoice is paid.
  const payment = gw.db.prepare("SELECT id, merchant_id, amount FROM payments WHERE json_extract(metadata, '$.invoice_id') = ?").get(inv.id) as { id: string; merchant_id: string; amount: number };
  assert.equal(payment.merchant_id, op.id);
  assert.equal(payment.amount, inv.total);
  await gw.app.inject({ method: "POST", url: `/v1/payments/${payment.id}/approve`, headers: { authorization: `Bearer ${op.live_secret_key}` } });
  const paid = (await accountant("GET", "/billing")).json().invoices[0];
  assert.equal(paid.status, "paid");
  assert.equal(paid.pay_url, null);
});

test("expired pay links are renewed; staff can mark paid or void; empty bills settle themselves", async () => {
  const { shop, root } = await setup();
  const free = (await root("POST", "/plans", { name: "Free", monthly_fee: 0, included_transactions: 100, per_transaction_fee: 0, percent_fee_bps: 0 })).json();
  const paidPlan = (await root("POST", "/plans", { name: "Pro", monthly_fee: 100000, included_transactions: 0, per_transaction_fee: 0, percent_fee_bps: 0 })).json();
  const other = await createMerchant(gw, "ร้านฟรี");
  await root("POST", `/merchants/${other.id}/plan`, { plan_id: free.id });
  await root("POST", `/merchants/${shop.id}/plan`, { plan_id: paidPlan.id });
  await root("POST", "/invoices/generate", {});
  const all = (await root("GET", "/invoices")).json().data;
  assert.equal(all.find((i: any) => i.merchant_id === other.id).status, "paid", "a zero bill needs no payment");
  const inv = all.find((i: any) => i.merchant_id === shop.id);

  gw.db.prepare("UPDATE payments SET expires_at = ? WHERE json_extract(metadata, '$.invoice_id') = ?").run(new Date(Date.now() - 1000).toISOString(), inv.id);
  const owner = await webLogin(gw, "dashboard", { secret_key: shop.live_secret_key });
  const link = (await owner("POST", `/invoices/${inv.id}/pay`)).json().url;
  assert.match(link, /\/checkout\/pay_/);
  assert.notEqual(link, inv.pay_url, "a fresh payment replaces the expired one");

  assert.equal((await root("POST", `/invoices/${inv.id}/status`, { status: "paid" })).json().status, "paid");
  assert.equal((await root("POST", `/invoices/${inv.id}/status`, { status: "void" })).statusCode, 409);
  assert.equal((await root("POST", "/invoices/generate", { period: bangkokMonth() })).statusCode, 400, "an open month cannot be invoiced");
});

test("billing permissions: support can view but not change plans or invoices", async () => {
  const { root } = await setup();
  const created = (await root("POST", "/admins", { email: "help@gw.th", name: "Help", role: "support" })).json();
  const support: Call = await webLogin(gw, "admin", { email: "help@gw.th", password: created.temporary_password });
  await support("POST", "/password", { current_password: created.temporary_password, new_password: "Supp0rtPassword" });
  assert.equal((await support("GET", "/plans")).statusCode, 200);
  assert.equal((await support("POST", "/plans", { name: "x", monthly_fee: 0, included_transactions: 0, per_transaction_fee: 0, percent_fee_bps: 0 })).statusCode, 403);
  assert.equal((await support("POST", "/invoices/generate", {})).statusCode, 403);
});
