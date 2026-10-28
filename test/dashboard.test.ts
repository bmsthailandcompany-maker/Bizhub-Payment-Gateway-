import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp, type Gateway } from "../src/app.ts";
import { openDb } from "../src/db.ts";

const ADMIN = "admin-token-for-tests-only";
let gw: Gateway;
let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bizhub-dash-"));
  gw = await buildApp(
    { port: 0, publicBaseUrl: "https://pay.example.com", adminToken: ADMIN, dataDir, defaultPaymentTtlSeconds: 900, omise: null, slipVerifier: null, workerIntervalMs: 0 },
    {
      db: openDb(":memory:"),
      fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch,
      logger: false,
      liveSlipVerifier: { name: "x", check: async () => ({ kind: "retry", reason: "bank_delay" }) },
    },
  );
});

afterEach(async () => {
  await gw.app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function merchant(name = "ร้านทดสอบ") {
  const res = await gw.app.inject({
    method: "POST",
    url: "/admin/merchants",
    headers: { authorization: `Bearer ${ADMIN}` },
    payload: { name, promptpay_id: "0812345678" },
  });
  return res.json() as { id: string; test_secret_key: string; live_secret_key: string };
}

async function login(key: string) {
  const res = await gw.app.inject({ method: "POST", url: "/dashboard/api/login", payload: { secret_key: key } });
  assert.equal(res.statusCode, 200, res.body);
  const cookie = String(res.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const session = cookie.split(";")[0]!;
  return (method: "GET" | "POST", url: string, payload?: unknown, extra: Record<string, string> = {}) =>
    gw.app.inject({
      method,
      url: "/dashboard/api" + url,
      payload: payload as any,
      headers: { cookie: session, "x-requested-with": "bizhub-dashboard", ...extra },
    });
}

test("dashboard page is served with a strict CSP", async () => {
  const res = await gw.app.inject({ method: "GET", url: "/dashboard" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-security-policy"] as string, /script-src 'nonce-/);
  assert.doesNotMatch(res.body, / style="/);
});

test("login rejects bad keys and API requires a session", async () => {
  assert.equal((await gw.app.inject({ method: "POST", url: "/dashboard/api/login", payload: { secret_key: "sk_live_nope" } })).statusCode, 401);
  assert.equal((await gw.app.inject({ method: "GET", url: "/dashboard/api/me" })).statusCode, 401);
  assert.equal((await gw.app.inject({ method: "GET", url: "/dashboard/api/me", headers: { cookie: "bizhub_session=forged" } })).statusCode, 401);
});

test("writes need the dashboard header (CSRF defence)", async () => {
  const m = await merchant();
  const call = await login(m.test_secret_key);
  const res = await call("POST", "/payments", { amount: 10000, method: "promptpay" }, { "x-requested-with": "" });
  assert.equal(res.statusCode, 403);
});

test("create a link, see it listed and searched, and summary counts it", async () => {
  const m = await merchant();
  const call = await login(m.test_secret_key);
  assert.equal((await call("GET", "/me")).json().livemode, false);

  const created = await call("POST", "/payments", { amount: 25000, method: "promptpay", reference: "INV-77", description: "ลาเต้" });
  assert.equal(created.statusCode, 201, created.body);
  const pay = created.json();

  assert.equal((await call("GET", "/payments?q=INV-77")).json().data.length, 1);
  assert.equal((await call("GET", "/payments?q=ลาเ")).json().data.length, 1);
  assert.equal((await call("GET", "/payments?q=nothing")).json().data.length, 0);
  assert.equal((await call("GET", "/payments?q=%25")).json().data.length, 0, "LIKE wildcards are escaped");

  const appr = await call("POST", `/payments/${pay.id}/approve`);
  assert.equal(appr.statusCode, 200, appr.body);
  const s = (await call("GET", "/summary")).json();
  assert.equal(s.today.amount, 25000);
  assert.equal(s.today.count, 1);
  assert.equal(s.daily.length, 14);
  assert.equal(s.daily.at(-1).amount, 25000);
});

test("review flow: slip waiting for review shows up, merchant sees slip and rejects it", async () => {
  const m = await merchant();
  const live = await login(m.live_secret_key);
  const pay = (await live("POST", "/payments", { amount: 10000, method: "promptpay" })).json();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const boundary = "----b";
  await gw.app.inject({
    method: "POST",
    url: `/checkout/${pay.id}/slip`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="slip"; filename="s.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });

  assert.equal((await live("GET", "/summary")).json().awaiting_review, 1);
  const detail = (await live("GET", `/payments/${pay.id}`)).json();
  assert.equal(detail.status, "awaiting_review");
  assert.equal(detail.slip_checks.length, 1);
  assert.equal((await live("GET", `/payments/${pay.id}/slip`)).headers["content-type"], "image/png");

  const rejected = await live("POST", `/payments/${pay.id}/reject`, { reason: "ไม่พบยอดเข้า" });
  assert.equal(rejected.json().status, "failed");
});

test("sessions are scoped to their merchant and mode, and die with key rotation", async () => {
  const a = await merchant("A");
  const b = await merchant("B");
  const callA = await login(a.test_secret_key);
  const payA = (await callA("POST", "/payments", { amount: 10000, method: "promptpay" })).json();

  const callB = await login(b.test_secret_key);
  assert.equal((await callB("GET", `/payments/${payA.id}`)).statusCode, 404);
  const liveA = await login(a.live_secret_key);
  assert.equal((await liveA("GET", `/payments/${payA.id}`)).statusCode, 404);

  await gw.app.inject({ method: "POST", url: `/admin/merchants/${a.id}/rotate-keys`, headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal((await callA("GET", "/me")).statusCode, 401);
});

test("logout ends the session", async () => {
  const m = await merchant();
  const call = await login(m.test_secret_key);
  await call("POST", "/logout");
  assert.equal((await call("GET", "/me")).statusCode, 401);
});
