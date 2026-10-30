import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Gateway } from "../src/app.ts";
import type { SlipCheck } from "../src/slip/types.ts";
import { type Call, createMerchant, makeGateway, staff, webLogin } from "./helpers.ts";

let gw: Gateway;
let cleanup: () => Promise<void>;
let nextCheck: (amount: number) => SlipCheck;
let checks: number;

const slipOf = (amount: number, ref = "REF" + Math.random().toString(36).slice(2)): SlipCheck => ({
  kind: "slip",
  slip: { transRef: ref, amount, paidAt: new Date().toISOString(), receiver: { name: null, proxy: null, account: "xxx-x-x6789-x" }, sender: { name: null, bank: null }, raw: {} },
});

beforeEach(async () => {
  checks = 0;
  nextCheck = (a) => slipOf(a);
  ({ gw, cleanup } = await makeGateway({
    liveSlipVerifier: { name: "fake", check: async (_i, _m, e) => { checks++; return nextCheck(e.amount); } },
  }));
});
afterEach(() => cleanup());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
function submit(merchantId: string, fields: Record<string, string>, file: Buffer | null = PNG, ip = "198.51.100.1") {
  const b = "----n";
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="slip"; filename="s.png"\r\nContent-Type: image/png\r\n\r\n`), file, Buffer.from("\r\n"));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return gw.app.inject({ method: "POST", url: `/notice/${merchantId}`, payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${b}` }, remoteAddress: ip });
}

async function shop(): Promise<{ id: string; owner: Call }> {
  const m = await createMerchant(gw);
  await gw.app.inject({ method: "PATCH", url: `/admin/merchants/${m.id}`, headers: { authorization: "Bearer admin-token-for-tests-only" }, payload: { bank_name: "กสิกรไทย", bank_account_no: "123-4-56789-0", bank_account_name: "ร้านทดสอบ" } });
  const owner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  return { id: m.id, owner };
}

test("the page is off until the owner turns it on, and only owners can", async () => {
  const { id, owner } = await shop();
  assert.equal((await gw.app.inject({ method: "GET", url: `/notice/${id}` })).statusCode, 404);
  assert.equal((await submit(id, { amount: "100", reference: "X" })).statusCode, 404);
  const mgr = await staff(gw, owner, "manager", "m@shop.th");
  assert.equal((await mgr("PATCH", "/notice", { enabled: true })).statusCode, 403);
  const on = await owner("PATCH", "/notice", { enabled: true });
  assert.equal(on.json().url, `https://pay.example.com/notice/${id}`);
  const page = await gw.app.inject({ method: "GET", url: `/notice/${id}` });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /123-4-56789-0/);
  assert.match(page.headers["content-security-policy"] as string, /nonce-/);
  assert.equal((await gw.app.inject({ method: "GET", url: `/notice/${id}/qr.png` })).headers["content-type"], "image/png");
  assert.equal((await owner("GET", "/me")).json().merchant.notice_enabled, true);
});

test("a verified slip records a paid payment with the customer's bill number", async () => {
  const { id, owner } = await shop();
  await owner("PATCH", "/notice", { enabled: true });
  const res = await submit(id, { amount: "1,250.50", reference: "INV-1024 คุณสมใจ" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, "succeeded");
  const list = (await owner("GET", "/payments?q=INV-1024")).json().data;
  assert.equal(list.length, 1);
  assert.equal(list[0].amount, 125050);
  assert.equal(list[0].confirmed_by, "slip");
  assert.equal(list[0].metadata.source, "notice_page");
});

test("rejected slips leave no unpaid bill behind; unverifiable ones wait for staff", async () => {
  const { id, owner } = await shop();
  await owner("PATCH", "/notice", { enabled: true });
  nextCheck = () => slipOf(50000);
  const low = await submit(id, { amount: "600", reference: "A" });
  assert.deepEqual([low.json().status, low.json().verification.reason], ["rejected", "amount_too_low"]);
  assert.equal((await owner("GET", "/payments?status=pending")).json().data.length, 0);

  nextCheck = () => ({ kind: "retry", reason: "bank_delay", retryAfterSeconds: 300 });
  const wait = await submit(id, { amount: "300", reference: "B" });
  assert.equal(wait.json().status, "awaiting_review");
  assert.equal((await owner("GET", "/summary")).json().awaiting_review, 1);
});

test("bad input is refused before spending a slip check, and submissions are rate limited", async () => {
  const { id, owner } = await shop();
  await owner("PATCH", "/notice", { enabled: true });
  assert.equal((await submit(id, { amount: "abc", reference: "A" }, PNG, "203.0.113.9")).json().error.code, "invalid_amount");
  assert.equal((await submit(id, { amount: "100", reference: "" }, PNG, "203.0.113.9")).json().error.code, "invalid_reference");
  assert.equal((await submit(id, { amount: "100", reference: "A" }, null, "203.0.113.9")).json().error.code, "invalid_file");
  assert.equal((await submit(id, { amount: "100", reference: "A" }, Buffer.from("not an image"), "203.0.113.9")).json().error.code, "invalid_file");
  assert.equal(checks, 0);
  for (let i = 0; i < 6; i++) await submit(id, { amount: "100", reference: "R" + i }, PNG, "203.0.113.9");
  assert.equal((await submit(id, { amount: "100", reference: "Z" }, PNG, "203.0.113.9")).statusCode, 429);
  assert.equal((await submit(id, { amount: "100", reference: "Z" }, PNG, "203.0.113.10")).statusCode, 200, "other visitors are unaffected");
});
