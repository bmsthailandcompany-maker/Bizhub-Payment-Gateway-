import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Gateway } from "../src/app.ts";
import { hmacSha256 } from "../src/ids.ts";
import { buildBillPaymentPayload, crc16 } from "../src/promptpay.ts";
import { parseBaht } from "../src/services/bank.ts";
import { type Call, createMerchant, makeGateway, staff, webLogin } from "./helpers.ts";

let gw: Gateway;
let cleanup: () => Promise<void>;
let sent: string[];
beforeEach(async () => {
  sent = [];
  ({ gw, cleanup } = await makeGateway({
    fetchImpl: (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string).type);
      return new Response("ok");
    }) as unknown as typeof fetch,
  }));
});
afterEach(() => cleanup());

function notify(connId: string, secret: string, body: Record<string, unknown>, opts: { t?: number; badSig?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const v1 = opts.badSig ? "0".repeat(64) : hmacSha256(secret, `${t}.${raw}`);
  return gw.app.inject({
    method: "POST",
    url: `/bank/notify/${connId}`,
    payload: raw,
    headers: { "content-type": "application/json", "bizhub-signature": `t=${t},v1=${v1}` },
  });
}

async function owner(mode: "test" | "live" = "test"): Promise<{ call: Call; m: Awaited<ReturnType<typeof createMerchant>> }> {
  const m = await createMerchant(gw);
  await gw.app.inject({
    method: "PATCH",
    url: `/admin/merchants/${m.id}`,
    headers: { authorization: "Bearer admin-token-for-tests-only" },
    payload: { bank_name: "KBank", bank_account_no: "123-4-56789-0", bank_account_name: "Shop" },
  });
  return { call: await webLogin(gw, "dashboard", { secret_key: mode === "test" ? m.test_secret_key : m.live_secret_key }), m };
}

test("bill-payment QR payload carries the biller ID and payment code with a valid CRC", () => {
  const p = buildBillPaymentPayload("010555512345601", "BZ7K2M9QXA", 15000);
  assert.match(p, /^000201010212/);
  assert.ok(p.includes("30530016A00000067701011201150105555123456010210BZ7K2M9QXA"));
  assert.ok(p.includes("5406150.00"));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
  assert.throws(() => buildBillPaymentPayload("123", "X", 100));
  assert.throws(() => buildBillPaymentPayload("010555512345601", "lower", 100));
});

test("parseBaht never loses or invents satang", () => {
  assert.equal(parseBaht("150.00"), 15000);
  assert.equal(parseBaht("1,250.5"), 125050);
  assert.equal(parseBaht(99.99), 9999);
  assert.equal(parseBaht(0.1 + 0.2), 30, "float noise around a 2-decimal amount is tolerated");
  assert.equal(parseBaht(12.345), null, "a third decimal is refused rather than rounded");
  assert.equal(parseBaht("12.345"), null);
  assert.equal(parseBaht("-5"), null);
});

test("with a Biller ID: QR names the payment and the bank's notification confirms it exactly once", async () => {
  const { call } = await owner();
  const conn = await call("POST", "/bank", { label: "KBank ร้านทดสอบ", biller_id: "010555512345601" });
  assert.equal(conn.statusCode, 201, conn.body);
  const { id, secret, notify_url, matching } = conn.json();
  assert.equal(matching, "reference");
  assert.equal(notify_url, `https://pay.example.com/bank/notify/${id}`);

  const pay = (await call("POST", "/payments", { amount: 15000, method: "promptpay" })).json();
  assert.match(pay.payment_code, /^[A-Z2-9]{10}$/);
  assert.ok(pay.promptpay.payload.includes("0115010555512345601"), "bill-payment QR with biller ID");
  assert.ok(pay.promptpay.payload.includes(pay.payment_code));

  const res = await notify(id, secret, { trans_ref: "KB0001", amount: "150.00", ref1: pay.payment_code.toLowerCase(), payer_name: "นาย ก" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().outcome, "matched");
  const after = (await call("GET", `/payments/${pay.id}`)).json();
  assert.equal(after.status, "succeeded");
  assert.equal(after.confirmed_by, "bank");

  const again = await notify(id, secret, { trans_ref: "KB0001", amount: "150.00", ref1: pay.payment_code });
  assert.equal(again.json().outcome, "duplicate");
  const events = (await call("GET", "/bank")).json().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "matched");

  await gw.runJobs();
  assert.deepEqual(sent, [], "this merchant has no webhook URL");
});

test("signatures are required and expire", async () => {
  const { call } = await owner();
  const { id, secret } = (await call("POST", "/bank", { label: "SCB" })).json();
  const body = { trans_ref: "X1", amount: 10 };
  assert.equal((await notify(id, secret, body, { badSig: true })).statusCode, 401);
  assert.equal((await notify(id, secret, body, { t: Math.floor(Date.now() / 1000) - 3600 })).statusCode, 401);
  assert.equal((await notify(id, "wrong-secret", body)).statusCode, 401);
  assert.equal((await notify("bnk_nope", secret, body)).statusCode, 404);
  const rotated = (await call("POST", "/bank/rotate-secret")).json().secret;
  assert.equal((await notify(id, secret, body)).statusCode, 401, "old secret stops working");
  assert.equal((await notify(id, rotated, body)).statusCode, 200);
  await call("POST", "/bank/disconnect");
  assert.equal((await notify(id, rotated, body)).statusCode, 404);
});

test("without a reference: one open payment with that amount matches; two are left for the merchant", async () => {
  const { call } = await owner();
  const { id, secret } = (await call("POST", "/bank", { label: "KBank" })).json();
  const a = (await call("POST", "/payments", { amount: 20000, method: "promptpay" })).json();
  assert.ok(!a.promptpay.payload.includes("A000000677010112"), "plain PromptPay QR without biller ID");
  assert.equal((await notify(id, secret, { trans_ref: "T1", amount: 200 })).json().outcome, "matched");
  assert.equal((await call("GET", `/payments/${a.id}`)).json().status, "succeeded");

  const b = (await call("POST", "/payments", { amount: 30000, method: "bank_transfer" })).json();
  const c = (await call("POST", "/payments", { amount: 30000, method: "promptpay" })).json();
  const amb = await notify(id, secret, { trans_ref: "T2", amount: "300.00" });
  assert.equal(amb.json().outcome, "ambiguous");
  for (const p of [b, c]) assert.equal((await call("GET", `/payments/${p.id}`)).json().status, "pending");
  assert.equal((await notify(id, secret, { trans_ref: "T3", amount: "999.00" })).json().outcome, "unmatched");
});

test("wrong amount goes to review; money for a closed payment is recorded but changes nothing", async () => {
  const { call } = await owner();
  const { id, secret } = (await call("POST", "/bank", { label: "KBank", biller_id: "010555512345601" })).json();
  const p = (await call("POST", "/payments", { amount: 50000, method: "promptpay" })).json();
  const low = await notify(id, secret, { trans_ref: "L1", amount: "450.00", ref1: p.payment_code });
  assert.deepEqual([low.json().outcome, low.json().reason], ["amount_mismatch", "amount_too_low"]);
  const reviewed = (await call("GET", `/payments/${p.id}`)).json();
  assert.equal(reviewed.status, "awaiting_review");
  assert.equal(reviewed.slip_verification.reason, "bank_amount_too_low");

  const q = (await call("POST", "/payments", { amount: 10000, method: "promptpay" })).json();
  await call("POST", `/payments/${q.id}/cancel`);
  const late = await notify(id, secret, { trans_ref: "L2", amount: "100.00", ref1: q.payment_code });
  assert.equal(late.json().outcome, "paid_after_close");
  assert.equal((await call("GET", `/payments/${q.id}`)).json().status, "cancelled");
});

test("a transfer confirmed by the bank cannot be reused as a slip for another payment", async () => {
  const nextRef = "SAME-REF";
  await cleanup();
  ({ gw, cleanup } = await makeGateway({
    liveSlipVerifier: {
      name: "fake",
      check: async (_i, _m, e) => ({
        kind: "slip",
        slip: { transRef: nextRef, amount: e.amount, paidAt: new Date().toISOString(), receiver: { name: null, proxy: "xxx-xxx-5678", account: null }, sender: { name: null, bank: null }, raw: {} },
      }),
    },
  }));
  const fresh = await owner("live");
  const { id, secret } = (await fresh.call("POST", "/bank", { label: "KBank" })).json();
  const a = (await fresh.call("POST", "/payments", { amount: 10000, method: "promptpay" })).json();
  assert.equal((await notify(id, secret, { trans_ref: nextRef, amount: "100.00" })).json().outcome, "matched");
  const b = (await fresh.call("POST", "/payments", { amount: 10000, method: "promptpay" })).json();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const boundary = "----x";
  const up = await gw.app.inject({
    method: "POST",
    url: `/checkout/${b.id}/slip`,
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="slip"; filename="s.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  assert.deepEqual(up.json().verification, { outcome: "rejected", reason: "duplicate_slip" });
  assert.equal((await fresh.call("GET", `/payments/${a.id}`)).json().status, "succeeded");
});

test("permissions: managers see the bank feed, only owners link it; simulation is test-mode only", async () => {
  const { call } = await owner();
  const mgr = await staff(gw, call, "manager", "m@shop.th");
  const cashier = await staff(gw, call, "cashier", "c@shop.th");
  assert.equal((await cashier("GET", "/bank")).statusCode, 403);
  await mgr("POST", "/mode", { livemode: false });
  assert.equal((await mgr("GET", "/bank")).json().connection, null);
  assert.equal((await mgr("POST", "/bank", { label: "x" })).statusCode, 403);
  assert.equal((await call("POST", "/bank", { label: "x", biller_id: "123" })).statusCode, 400);

  await call("POST", "/bank", { label: "KBank" });
  const p = (await call("POST", "/payments", { amount: 12300, method: "promptpay" })).json();
  const sim = await call("POST", "/bank/simulate", { payment_id: p.id });
  assert.equal(sim.json().outcome, "matched");
  const log = (await call("GET", "/audit")).json().data.map((e: any) => e.action);
  assert.ok(log.includes("bank.connect"));
  assert.ok(log.includes("payment.bank_confirmed"));
});

test("staff resolve an ambiguous transfer by choosing the payment; resolved events cannot be reassigned", async () => {
  const { call } = await owner();
  const { id, secret } = (await call("POST", "/bank", { label: "KBank" })).json();
  const a = (await call("POST", "/payments", { amount: 30000, method: "promptpay", reference: "A" })).json();
  const b = (await call("POST", "/payments", { amount: 30000, method: "promptpay", reference: "B" })).json();
  const ev = (await notify(id, secret, { trans_ref: "AMB1", amount: "300.00" })).json();
  assert.equal(ev.outcome, "ambiguous");
  const cashier = await staff(gw, call, "cashier", "c@shop.th");
  await cashier("POST", "/mode", { livemode: false });
  const r = await cashier("POST", `/bank/events/${ev.event_id}/assign`, { payment_id: b.id });
  assert.equal(r.json().outcome, "matched");
  assert.equal((await call("GET", `/payments/${b.id}`)).json().confirmed_by, "bank");
  assert.equal((await call("GET", `/payments/${a.id}`)).json().status, "pending");
  assert.equal((await call("POST", `/bank/events/${ev.event_id}/assign`, { payment_id: a.id })).statusCode, 409);
  const events = (await call("GET", "/bank")).json().events;
  assert.equal(events[0].reason, "assigned_by_staff");
});
