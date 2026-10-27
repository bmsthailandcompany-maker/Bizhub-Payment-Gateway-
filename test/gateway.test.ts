import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp, type Gateway } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { hmacSha256 } from "../src/ids.ts";

const ADMIN = "admin-token-for-tests-only";
let gw: Gateway;
let dataDir: string;
let sent: { url: string; headers: Record<string, string>; body: string }[];
let webhookStatus: number;

const fakeFetch = (async (url: string, init: RequestInit) => {
  sent.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
  return new Response("ok", { status: webhookStatus });
}) as unknown as typeof fetch;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bizhub-test-"));
  sent = [];
  webhookStatus = 200;
  const config: Config = {
    port: 0,
    publicBaseUrl: "https://pay.example.com",
    adminToken: ADMIN,
    dataDir,
    defaultPaymentTtlSeconds: 900,
    omise: null,
    workerIntervalMs: 0,
  };
  gw = await buildApp(config, { db: openDb(":memory:"), fetchImpl: fakeFetch, logger: false });
});

afterEach(async () => {
  await gw.app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function createMerchant(extra: Record<string, unknown> = {}) {
  const res = await gw.app.inject({
    method: "POST",
    url: "/admin/merchants",
    headers: { authorization: `Bearer ${ADMIN}` },
    payload: {
      name: "ร้านทดสอบ",
      promptpay_id: "0812345678",
      bank_name: "KBank",
      bank_account_no: "123-4-56789-0",
      bank_account_name: "Test Shop",
      webhook_url: "https://merchant.example.com/hook",
      ...extra,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; test_secret_key: string; live_secret_key: string; webhook_secret: string };
}

function api(key: string) {
  return (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    gw.app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${key}`, ...headers } });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

function multipart(field: string, filename: string, mime: string, data: Buffer) {
  const boundary = "----bizhubtest";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

test("rejects requests without valid credentials", async () => {
  assert.equal((await gw.app.inject({ method: "GET", url: "/v1/payments" })).statusCode, 401);
  assert.equal((await api("sk_test_nope")("GET", "/v1/payments")).statusCode, 401);
  assert.equal((await gw.app.inject({ method: "GET", url: "/admin/merchants", headers: { authorization: "Bearer wrong" } })).statusCode, 401);
});

test("PromptPay flow: create → QR → slip → merchant approves → signed webhook", async () => {
  const m = await createMerchant();
  const call = api(m.test_secret_key);

  const created = await call("POST", "/v1/payments", { amount: 15000, method: "promptpay", reference: "ORDER-1" });
  assert.equal(created.statusCode, 201, created.body);
  const pay = created.json();
  assert.equal(pay.status, "pending");
  assert.equal(pay.livemode, false);
  assert.match(pay.promptpay.payload, /^000201010212.*5406150\.006304[0-9A-F]{4}$/);
  assert.equal(pay.checkout_url, `https://pay.example.com/checkout/${pay.id}`);

  const page = await gw.app.inject({ method: "GET", url: `/checkout/${pay.id}` });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /ร้านทดสอบ/);
  assert.match(page.headers["content-security-policy"] as string, /nonce-/);

  const qr = await gw.app.inject({ method: "GET", url: `/checkout/${pay.id}/qr.png` });
  assert.equal(qr.statusCode, 200);
  assert.equal(qr.headers["content-type"], "image/png");

  const up = await gw.app.inject({ method: "POST", url: `/checkout/${pay.id}/slip`, ...multipart("slip", "slip.png", "image/png", PNG) });
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(up.json().status, "awaiting_review");

  const slip = await call("GET", `/v1/payments/${pay.id}/slip`);
  assert.equal(slip.statusCode, 200);
  assert.equal(slip.headers["content-type"], "image/png");

  const approved = await call("POST", `/v1/payments/${pay.id}/approve`);
  assert.equal(approved.json().status, "succeeded");
  assert.ok(approved.json().paid_at);

  await gw.runJobs();
  const types = sent.map((s) => JSON.parse(s.body).type);
  assert.deepEqual(types, ["payment.created", "payment.awaiting_review", "payment.succeeded"]);

  const last = sent.at(-1)!;
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(last.headers["Bizhub-Signature"]!)!;
  assert.equal(v1, hmacSha256(m.webhook_secret, `${t}.${last.body}`));
});

test("slip upload rejects files whose bytes do not match the declared type", async () => {
  const m = await createMerchant();
  const pay = (await api(m.test_secret_key)("POST", "/v1/payments", { amount: 10000, method: "bank_transfer" })).json();
  const res = await gw.app.inject({
    method: "POST",
    url: `/checkout/${pay.id}/slip`,
    ...multipart("slip", "evil.png", "image/png", Buffer.from("MZ not really a png")),
  });
  assert.equal(res.statusCode, 400);
});

test("merchant can reject a slip", async () => {
  const m = await createMerchant();
  const call = api(m.test_secret_key);
  const pay = (await call("POST", "/v1/payments", { amount: 10000, method: "bank_transfer" })).json();
  await gw.app.inject({ method: "POST", url: `/checkout/${pay.id}/slip`, ...multipart("slip", "s.png", "image/png", PNG) });
  const res = await call("POST", `/v1/payments/${pay.id}/reject`, { reason: "amount_mismatch" });
  assert.equal(res.json().status, "failed");
  assert.equal(res.json().failure_reason, "amount_mismatch");
});

test("card flow in test mode: decline can be retried, then succeeds", async () => {
  const m = await createMerchant();
  const pay = (await api(m.test_secret_key)("POST", "/v1/payments", { amount: 99900, method: "card" })).json();

  const declined = await gw.app.inject({ method: "POST", url: `/checkout/${pay.id}/card`, payload: { token: "tok_test_0002" } });
  assert.equal(declined.json().status, "pending");
  assert.equal(declined.json().failure_reason, "card_declined");

  const ok = await gw.app.inject({ method: "POST", url: `/checkout/${pay.id}/card`, payload: { token: "tok_test_4242" } });
  assert.equal(ok.json().status, "succeeded");

  const again = await gw.app.inject({ method: "POST", url: `/checkout/${pay.id}/card`, payload: { token: "tok_test_4242" } });
  assert.equal(again.statusCode, 409);
});

test("live card payments are refused when no card provider is configured", async () => {
  const m = await createMerchant();
  const res = await api(m.live_secret_key)("POST", "/v1/payments", { amount: 10000, method: "card" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "method_unavailable");
});

test("idempotency key returns the same payment and rejects changed parameters", async () => {
  const m = await createMerchant();
  const call = api(m.test_secret_key);
  const body = { amount: 5000, method: "promptpay" };
  const a = await call("POST", "/v1/payments", body, { "idempotency-key": "abc" });
  const b = await call("POST", "/v1/payments", body, { "idempotency-key": "abc" });
  assert.equal(a.json().id, b.json().id);
  const c = await call("POST", "/v1/payments", { ...body, amount: 6000 }, { "idempotency-key": "abc" });
  assert.equal(c.statusCode, 409);
});

test("test and live data are isolated, and merchants cannot see each other's payments", async () => {
  const m1 = await createMerchant();
  const m2 = await createMerchant({ name: "อีกร้าน" });
  const pay = (await api(m1.test_secret_key)("POST", "/v1/payments", { amount: 5000, method: "promptpay" })).json();
  assert.equal((await api(m1.live_secret_key)("GET", `/v1/payments/${pay.id}`)).statusCode, 404);
  assert.equal((await api(m2.test_secret_key)("GET", `/v1/payments/${pay.id}`)).statusCode, 404);
  assert.equal((await api(m1.test_secret_key)("GET", "/v1/payments")).json().data.length, 1);
  assert.equal((await api(m2.test_secret_key)("GET", "/v1/payments")).json().data.length, 0);
});

test("expired payments stop accepting money", async () => {
  const m = await createMerchant();
  const call = api(m.test_secret_key);
  const pay = (await call("POST", "/v1/payments", { amount: 5000, method: "promptpay", expires_in: 60 })).json();
  gw.db.prepare("UPDATE payments SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), pay.id);
  await gw.runJobs();
  assert.equal((await call("GET", `/v1/payments/${pay.id}`)).json().status, "expired");
  assert.equal((await gw.app.inject({ method: "GET", url: `/checkout/${pay.id}/qr.png` })).statusCode, 410);
  const up = await gw.app.inject({ method: "POST", url: `/checkout/${pay.id}/slip`, ...multipart("slip", "s.png", "image/png", PNG) });
  assert.equal(up.statusCode, 409);
});

test("failed webhook deliveries are retried with backoff", async () => {
  webhookStatus = 500;
  const m = await createMerchant();
  await api(m.test_secret_key)("POST", "/v1/payments", { amount: 5000, method: "promptpay" });
  await gw.runJobs();
  assert.equal(sent.length, 1);
  await gw.runJobs();
  assert.equal(sent.length, 1, "should wait for the backoff before retrying");
  const d = gw.db.prepare("SELECT status, attempts, last_status_code FROM webhook_deliveries").get() as any;
  assert.deepEqual({ ...d }, { status: "pending", attempts: 1, last_status_code: 500 });
});

test("validation errors return 400 with details", async () => {
  const m = await createMerchant();
  const res = await api(m.test_secret_key)("POST", "/v1/payments", { amount: 10.5, method: "bitcoin" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "validation_error");
});

test("simulate is only allowed with test keys", async () => {
  const m = await createMerchant();
  const pay = (await api(m.live_secret_key)("POST", "/v1/payments", { amount: 5000, method: "promptpay" })).json();
  assert.equal((await api(m.live_secret_key)("POST", `/v1/payments/${pay.id}/simulate`, { status: "succeeded" })).statusCode, 400);
});
