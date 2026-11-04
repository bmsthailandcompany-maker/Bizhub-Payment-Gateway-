import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Gateway } from "../src/app.ts";
import { parseTrustProxy } from "../src/config.ts";
import { type CardChargeRequest, type CardChargeResult, CardProviderError, type CardProvider } from "../src/providers/card.ts";
import { bangkokMonth, previousMonth } from "../src/services/billing.ts";
import { PaymentError, type PaymentRow } from "../src/services/payments.ts";
import { LoginLimiter } from "../src/services/sessions.ts";
import { isPublicAddress } from "../src/services/webhooks.ts";
import type { SlipCheck } from "../src/slip/types.ts";
import type { AppDeps } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { createMerchant, makeGateway } from "./helpers.ts";

let gw: Gateway;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function start(deps: Partial<AppDeps> = {}, config: Partial<Config> = {}) {
  ({ gw, cleanup } = await makeGateway(deps, config));
  const m = await createMerchant(gw);
  return gw.merchants.get(m.id)!;
}

function setPast(id: string, column = "expires_at") {
  gw.db.prepare(`UPDATE payments SET ${column} = ? WHERE id = ?`).run(new Date(Date.now() - 10 * 60_000).toISOString(), id);
}

/** A live card provider whose answers the test scripts. */
class ScriptedCards implements CardProvider {
  readonly name = "scripted";
  calls: CardChargeRequest[] = [];
  onCharge: (req: CardChargeRequest) => Promise<CardChargeResult> = async () => ({ status: "succeeded", providerRef: "ch_1" });
  onRetrieve: (ref: string) => Promise<CardChargeResult> = async (ref) => ({ status: "pending", providerRef: ref });
  charge(req: CardChargeRequest) {
    this.calls.push(req);
    return this.onCharge(req);
  }
  retrieve(ref: string) {
    return this.onRetrieve(ref);
  }
}

async function cardPayment(cards: ScriptedCards) {
  const merchant = await start({ liveCardProvider: cards });
  const p = gw.payments.create(merchant, true, { amount: 50000, currency: "THB", method: "card" });
  return { merchant, p };
}

// --- 1. Card charges vs expiry / cancellation ---

test("a card charge in flight stops the payment expiring, and its success is recorded", async () => {
  const cards = new ScriptedCards();
  let finish!: (r: CardChargeResult) => void;
  cards.onCharge = () => new Promise((resolve) => (finish = resolve));
  const { p } = await cardPayment(cards);

  const charging = gw.payments.chargeCard(p.id, "tokn_1");
  setPast(p.id);
  gw.payments.sweepExpired();
  assert.equal(gw.payments.get(p.id)!.status, "pending", "must not expire while the provider is charging");
  assert.throws(() => gw.payments.transition(p.id, "cancelled"), (e: PaymentError) => e.code === "charge_in_progress");

  finish({ status: "succeeded", providerRef: "ch_1" });
  const { payment } = await charging;
  assert.equal(payment.status, "succeeded");
  assert.equal(payment.charge_token, null, "the card token is dropped once the outcome is known");
});

test("a 3-D Secure charge past expiry is settled with the provider before the payment closes", async () => {
  const cards = new ScriptedCards();
  cards.onCharge = async () => ({ status: "pending", providerRef: "ch_3ds", authorizeUri: "https://bank/3ds" });
  const { p } = await cardPayment(cards);
  await gw.payments.chargeCard(p.id, "tokn_1");

  setPast(p.id);
  setPast(p.id, "updated_at");
  gw.payments.sweepExpired();
  assert.equal(gw.payments.get(p.id)!.status, "pending");

  // The customer finished 3-D Secure late: the background check finds the captured charge.
  cards.onRetrieve = async (ref) => ({ status: "succeeded", providerRef: ref });
  await gw.runJobs();
  assert.equal(gw.payments.get(p.id)!.status, "succeeded");
});

test("an abandoned 3-D Secure charge lets the payment expire once the provider says it failed", async () => {
  const cards = new ScriptedCards();
  cards.onCharge = async () => ({ status: "pending", providerRef: "ch_3ds" });
  const { p } = await cardPayment(cards);
  await gw.payments.chargeCard(p.id, "tokn_1");
  setPast(p.id);
  setPast(p.id, "updated_at");
  cards.onRetrieve = async (ref) => ({ status: "failed", providerRef: ref, failureReason: "expired" });
  await gw.runJobs();
  assert.equal(gw.payments.get(p.id)!.status, "expired");
});

test("a charge captured after the payment closed is still recorded on return from 3-D Secure", async () => {
  const cards = new ScriptedCards();
  cards.onCharge = async () => ({ status: "pending", providerRef: "ch_late" });
  const { p } = await cardPayment(cards);
  await gw.payments.chargeCard(p.id, "tokn_1");
  // Closed by an older version that did not guard card charges.
  gw.db.prepare("UPDATE payments SET status = 'expired' WHERE id = ?").run(p.id);
  cards.onRetrieve = async (ref) => ({ status: "succeeded", providerRef: ref });
  assert.equal((await gw.payments.refreshCard(p.id)).status, "succeeded");
});

// --- 2. Lost provider answers never lead to a second charge ---

test("a timed-out charge is not retried by the customer but re-sent with the same idempotency key", async () => {
  const cards = new ScriptedCards();
  cards.onCharge = async () => {
    throw new CardProviderError("timeout", false);
  };
  const { p } = await cardPayment(cards);

  await assert.rejects(gw.payments.chargeCard(p.id, "tokn_1"), (e: PaymentError) => e.code === "charge_unconfirmed");
  await assert.rejects(gw.payments.chargeCard(p.id, "tokn_2"), (e: PaymentError) => e.code === "charge_in_progress");

  cards.onCharge = async () => ({ status: "succeeded", providerRef: "ch_1" });
  await gw.runJobs();
  assert.equal(gw.payments.get(p.id)!.status, "pending", "waits for the stale window first");

  setPast(p.id, "charge_started_at");
  await gw.runJobs();
  assert.equal(gw.payments.get(p.id)!.status, "succeeded");
  assert.equal(cards.calls.length, 2);
  assert.equal(cards.calls[0]!.idempotencyKey, cards.calls[1]!.idempotencyKey);
  assert.equal(cards.calls[1]!.token, "tokn_1");
});

test("a charge the provider refused outright can be retried by the customer", async () => {
  const cards = new ScriptedCards();
  cards.onCharge = async () => {
    throw new CardProviderError("Omise invalid_card: bad token", true);
  };
  const { p } = await cardPayment(cards);
  await assert.rejects(gw.payments.chargeCard(p.id, "tokn_1"), (e: PaymentError) => e.code === "provider_error");
  cards.onCharge = async () => ({ status: "succeeded", providerRef: "ch_2" });
  assert.equal((await gw.payments.chargeCard(p.id, "tokn_2")).payment.status, "succeeded");
  assert.notEqual(cards.calls[0]!.idempotencyKey, cards.calls[1]!.idempotencyKey);
});

// --- 3. Bank notifications are never stuck ---

async function bankSetup() {
  const merchant = await start();
  const conn = gw.bank.connect(merchant.id, false, { label: "KBank" });
  const p = gw.payments.create(merchant, false, { amount: 15000, currency: "THB", method: "promptpay" });
  return { merchant, conn, p };
}

test("an error while matching leaves the transfer assignable instead of stuck in processing", async () => {
  const { conn, p } = await bankSetup();
  const original = gw.payments.transition.bind(gw.payments);
  gw.payments.transition = () => {
    throw new Error("disk I/O error");
  };
  const r = gw.bank.handle(conn, { trans_ref: "T1", amount: "150.00" });
  gw.payments.transition = original;
  assert.equal(r.outcome, "unmatched");
  assert.equal(r.reason, "processing_error");
  assert.equal(gw.bank.assign(conn.merchant_id, false, r.event_id!, gw.payments.get(p.id)!).outcome, "matched");
});

test("a notification cut off mid-way is finished when the bank re-sends it", async () => {
  const { conn, p } = await bankSetup();
  gw.db
    .prepare(
      `INSERT INTO bank_events (id, connection_id, merchant_id, livemode, trans_ref, amount, paid_at, outcome, created_at)
       VALUES ('bev_crash', ?, ?, 0, 'T2', 15000, ?, 'processing', ?)`,
    )
    .run(conn.id, conn.merchant_id, new Date().toISOString(), new Date().toISOString());
  const r = gw.bank.handle(conn, { trans_ref: "T2", amount: "150.00" });
  assert.equal(r.outcome, "matched");
  assert.equal(gw.payments.get(p.id)!.status, "succeeded");
});

test("a wrong amount for a payment that just expired is reported as paid after close", async () => {
  const merchant = await start();
  // With a Biller ID the notification names the payment, so a wrong amount reaches that payment.
  const conn = gw.bank.connect(merchant.id, false, { label: "KBank", biller_id: "010555512345601" });
  const p = gw.payments.create(merchant, false, { amount: 15000, currency: "THB", method: "promptpay" });
  const original = gw.payments.transition.bind(gw.payments);
  gw.payments.transition = (id, to, extra) => {
    gw.payments.transition = original;
    gw.db.prepare("UPDATE payments SET status = 'expired' WHERE id = ?").run(id);
    return original(id, to, extra);
  };
  const r = gw.bank.handle(conn, { trans_ref: "T3", amount: "149.00", ref1: p.ref_code! });
  assert.equal(r.outcome, "paid_after_close");
  assert.equal(r.payment_id, p.id);
});

// --- 4. One transfer pays one payment, even through manual review ---

async function slipSetup(check: () => SlipCheck) {
  const merchant = await start({ liveSlipVerifier: { name: "scripted", check: async () => check() } });
  const pay = () => gw.payments.create(merchant, true, { amount: 15000, currency: "THB", method: "promptpay" });
  return { merchant, pay };
}

const overpaid = (transRef: string): SlipCheck => ({
  kind: "slip",
  slip: {
    transRef,
    amount: 20000,
    paidAt: new Date(Date.now() + 1000).toISOString(),
    receiver: { name: "SHOP", proxy: "xxx-xxx-5678", account: null },
    sender: { name: "C", bank: "004" },
    raw: {},
  },
});

test("a slip that went to review cannot be reused for another payment, before or after approval", async () => {
  const { pay } = await slipSetup(() => overpaid("TXSAME"));
  const a = pay();
  const first = await gw.slips.submit(a.id, "image/png", Buffer.from("x"));
  assert.equal(first.payment.status, "awaiting_review");
  assert.equal(first.result.reason, "amount_too_high");

  const b = pay();
  const second = await gw.slips.submit(b.id, "image/png", Buffer.from("x"));
  assert.deepEqual(second.result, { outcome: "rejected", reason: "duplicate_slip" });
  assert.equal(second.payment.status, "pending");

  gw.payments.approve(gw.payments.get(a.id)!);
  const used = gw.db.prepare("SELECT payment_id FROM used_slips WHERE trans_ref = 'TXSAME'").get() as { payment_id: string };
  assert.equal(used.payment_id, a.id, "approving claims the transfer");
  const c = pay();
  assert.equal((await gw.slips.submit(c.id, "image/png", Buffer.from("x"))).result.reason, "duplicate_slip");
});

test("approving a payment whose transfer already paid another payment is refused", async () => {
  const { pay } = await slipSetup(() => overpaid("TXDUP"));
  const a = pay();
  await gw.slips.submit(a.id, "image/png", Buffer.from("x"));
  gw.db.prepare("INSERT INTO used_slips (trans_ref, payment_id, created_at) VALUES ('TXDUP', 'pay_other', ?)").run(new Date().toISOString());
  assert.throws(() => gw.payments.approve(gw.payments.get(a.id)!), (e: PaymentError) => e.code === "transfer_used");
});

// --- 5. Invoices stay linked to the payment that pays them ---

async function invoiceSetup() {
  ({ gw, cleanup } = await makeGateway({}, {
    billing: { vatRateBps: 700, dueDays: 7, billingMerchantId: null, issuer: { name: "Bizhub", taxId: null, address: null } },
  }));
  const op = await createMerchant(gw, "Operator");
  (gw.billing.config as { billingMerchantId: string | null }).billingMerchantId = op.id;
  const shop = await createMerchant(gw, "Shop");
  const plan = gw.db.prepare(
    "INSERT INTO plans (id, name, monthly_fee, included_transactions, per_transaction_fee, percent_fee_bps, active, created_at) VALUES ('pln_t', 'P', 49000, 0, 0, 0, 1, ?)",
  );
  plan.run(new Date().toISOString());
  gw.db.prepare("UPDATE merchants SET plan_id = 'pln_t' WHERE id = ?").run(shop.id);
  const inv = gw.billing.issue(shop.id, previousMonth(bangkokMonth()))!;
  return { inv };
}

const invoice = (id: string) => gw.db.prepare("SELECT status, payment_id FROM invoices WHERE id = ?").get(id) as { status: string; payment_id: string };

test("re-opening the pay link keeps a payment that waits for slip review, and approving it pays the invoice", async () => {
  const { inv } = await invoiceSetup();
  const paymentId = invoice(inv.id).payment_id;
  gw.db.prepare("UPDATE payments SET status = 'awaiting_review' WHERE id = ?").run(paymentId);
  gw.billing.payLink(inv.id);
  assert.equal(invoice(inv.id).payment_id, paymentId, "not replaced");
  gw.payments.approve(gw.payments.get(paymentId)!);
  assert.equal(invoice(inv.id).status, "paid");
});

test("an older payment link that is paid after being replaced still pays the invoice", async () => {
  const { inv } = await invoiceSetup();
  const old = invoice(inv.id).payment_id;
  gw.db.prepare("UPDATE payments SET status = 'awaiting_review' WHERE id = ?").run(old);
  gw.db.prepare("UPDATE invoices SET payment_id = 'pay_newer' WHERE id = ?").run(inv.id);
  gw.payments.approve(gw.payments.get(old)!);
  assert.deepEqual({ ...invoice(inv.id) }, { status: "paid", payment_id: old });
});

test("a shop cannot mark an invoice paid by putting its id in a payment's metadata", async () => {
  const { inv } = await invoiceSetup();
  const shop = gw.merchants.get((gw.db.prepare("SELECT merchant_id FROM invoices WHERE id = ?").get(inv.id) as { merchant_id: string }).merchant_id)!;
  const fake = gw.payments.create(shop, true, { amount: inv.total, currency: "THB", method: "promptpay", metadata: { invoice_id: inv.id } });
  gw.payments.approve(fake);
  assert.equal(invoice(inv.id).status, "issued");
});

// --- 6. Client IPs and login limits ---

test("TRUST_PROXY trusts one proxy hop by default and refuses to trust everything", () => {
  assert.equal(parseTrustProxy(undefined), 1);
  assert.equal(parseTrustProxy("2"), 2);
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy("10.0.0.0/8"), "10.0.0.0/8");
  assert.throws(() => parseTrustProxy("true"));
});

test("a forged X-Forwarded-For entry does not change the client IP seen behind the proxy", async () => {
  await start();
  for (let i = 0; i < 5; i++) {
    // The proxy appends the real client address (198.51.100.7) after whatever the client sent.
    const res = await gw.app.inject({
      method: "POST",
      url: "/dashboard/api/login",
      headers: { "x-requested-with": "bizhub-web", "x-forwarded-for": `10.9.${i}.1, 198.51.100.7` },
      payload: { email: "victim@shop.th", password: "wrong-password" },
    });
    assert.equal(res.statusCode, 401);
  }
  const res = await gw.app.inject({
    method: "POST",
    url: "/dashboard/api/login",
    headers: { "x-requested-with": "bizhub-web", "x-forwarded-for": "10.9.99.1, 198.51.100.7" },
    payload: { email: "victim@shop.th", password: "wrong-password" },
  });
  assert.equal(res.statusCode, 429);
});

test("an account is locked after many failures even from rotating IP addresses", () => {
  const limiter = new LoginLimiter(5, 60_000, 30);
  for (let i = 0; i < 30; i++) limiter.fail(`10.0.0.${i}|victim@shop.th`);
  assert.ok(limiter.blocked("10.0.1.1|victim@shop.th"));
  assert.ok(!limiter.blocked("10.0.1.1|other@shop.th"));
  for (let i = 0; i < 40; i++) limiter.fail(`10.0.0.${i}|secret-key`);
  assert.ok(!limiter.blocked("10.0.9.9|secret-key"), "secret-key logins name no account to lock");
});

test("a malformed session cookie is treated as signed out, not a server error", async () => {
  await start();
  const res = await gw.app.inject({ method: "GET", url: "/dashboard/api/me", headers: { cookie: "bizhub_session=%E0%A4%A" } });
  assert.equal(res.statusCode, 401);
});

// --- 7. Webhooks never reach internal addresses ---

test("private, loopback and metadata addresses are not public", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "203.0.113.10", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("a webhook URL that resolves to an internal address is never called", async () => {
  const calls: string[] = [];
  const merchant = await start({
    fetchImpl: (async (url: string) => {
      calls.push(url);
      return new Response("ok");
    }) as unknown as typeof fetch,
    resolveHost: async (host) => (host === "metadata.evil.example" ? ["169.254.169.254"] : ["203.0.113.10"]),
  });
  for (const url of ["http://metadata.evil.example/latest", "http://127.0.0.1:3000/admin", "http://localhost/x", "http://[::1]/x"]) {
    gw.db.prepare("UPDATE merchants SET webhook_url = ? WHERE id = ?").run(url, merchant.id);
    gw.payments.create(merchant, false, { amount: 100, currency: "THB", method: "promptpay" });
  }
  gw.db.prepare("UPDATE merchants SET webhook_url = 'https://shop.example/hook' WHERE id = ?").run(merchant.id);
  gw.payments.create(merchant, false, { amount: 100, currency: "THB", method: "promptpay" });
  await gw.runJobs();
  assert.deepEqual(calls, ["https://shop.example/hook"]);
  const failed = gw.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'failed'").get() as { n: number };
  assert.equal(failed.n, 4);
});

// --- 8. One failing background job does not stop the others ---

test("webhooks are still delivered when another background job throws", async () => {
  const calls: string[] = [];
  const merchant = await start({
    fetchImpl: (async (url: string) => {
      calls.push(url);
      return new Response("ok");
    }) as unknown as typeof fetch,
  });
  gw.db.prepare("UPDATE merchants SET webhook_url = 'https://shop.example/hook' WHERE id = ?").run(merchant.id);
  gw.payments.create(merchant, false, { amount: 100, currency: "THB", method: "promptpay" });
  gw.billing.runMonthly = () => {
    throw new Error("billing broke");
  };
  gw.payments.sweepExpired = () => {
    throw new Error("sweep broke");
  };
  await gw.runJobs();
  assert.equal(calls.length, 1);
});

// --- 9. Background slip re-checks respect the merchant's decision ---

test("a background re-check that finishes after the merchant approved leaves the payment alone", async () => {
  let answer: () => SlipCheck = () => ({ kind: "retry", reason: "bank_delay", retryAfterSeconds: 60 });
  const { pay } = await slipSetup(() => answer());
  const p = pay();
  await gw.slips.submit(p.id, "image/png", Buffer.from("x"));
  gw.db.prepare("UPDATE payments SET verify_retry_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), p.id);

  answer = () => {
    gw.payments.approve(gw.payments.get(p.id)!); // the merchant approves while the check runs
    return { kind: "invalid", reason: "transfer_not_found" };
  };
  await gw.slips.retryDue();
  const after = gw.payments.get(p.id) as PaymentRow;
  assert.equal(after.status, "succeeded");
  assert.notEqual(after.verify_status, "rejected");
});

// --- 10. Idempotency keys are per mode ---

test("an Idempotency-Key used in test mode does not return a test payment to a live request", async () => {
  const merchant = await start();
  const input = { amount: 15000, currency: "THB" as const, method: "promptpay" as const };
  const t = gw.payments.create(merchant, false, input, "order-1");
  const l = gw.payments.create(merchant, true, input, "order-1");
  assert.notEqual(t.id, l.id);
  assert.equal(l.livemode, 1);
  assert.equal(gw.payments.create(merchant, true, input, "order-1").id, l.id, "still idempotent within a mode");
  assert.equal(gw.payments.create(merchant, false, input, "order-1").id, t.id);
});

test("idempotency keys stored before the mode prefix still work for their own mode", async () => {
  const merchant = await start();
  const input = { amount: 15000, currency: "THB" as const, method: "promptpay" as const };
  const t = gw.payments.create(merchant, false, input);
  const { sha256 } = await import("../src/ids.ts");
  gw.db
    .prepare("INSERT INTO idempotency_keys (merchant_id, key, request_hash, payment_id, created_at) VALUES (?, 'legacy', ?, ?, ?)")
    .run(merchant.id, sha256(JSON.stringify(input)), t.id, new Date().toISOString());
  assert.equal(gw.payments.create(merchant, false, input, "legacy").id, t.id);
  assert.notEqual(gw.payments.create(merchant, true, input, "legacy").id, t.id);
});
