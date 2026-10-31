import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Gateway } from "../src/app.ts";
import { ADMIN, createMerchant, makeGateway, staff, webLogin } from "./helpers.ts";

let gw: Gateway;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ gw, cleanup } = await makeGateway({
    liveSlipVerifier: { name: "x", check: async () => ({ kind: "retry", reason: "bank_delay" }) },
  }));
});
afterEach(() => cleanup());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
function uploadSlip(id: string) {
  const boundary = "----b";
  return gw.app.inject({
    method: "POST",
    url: `/checkout/${id}/slip`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="slip"; filename="s.png"\r\nContent-Type: image/png\r\n\r\n`),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
}

test("dashboard page loads scripts under a strict CSP", async () => {
  const res = await gw.app.inject({ method: "GET", url: "/dashboard" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-security-policy"] as string, /script-src 'self'/);
  assert.doesNotMatch(res.body, /<script>/);
  for (const f of ["ui.js", "ui.css", "dashboard.js", "admin.js"]) {
    assert.equal((await gw.app.inject({ method: "GET", url: `/assets/${f}` })).statusCode, 200, f);
  }
  assert.equal((await gw.app.inject({ method: "GET", url: "/assets/..%2Fapp.ts" })).statusCode, 404);
});

test("login rejects bad credentials, needs the CSRF header, and the API requires a session", async () => {
  const bad = await gw.app.inject({ method: "POST", url: "/dashboard/api/login", payload: { secret_key: "sk_live_nope" }, headers: { "x-requested-with": "bizhub-web" } });
  assert.equal(bad.statusCode, 401);
  const m = await createMerchant(gw);
  const noHeader = await gw.app.inject({ method: "POST", url: "/dashboard/api/login", payload: { secret_key: m.test_secret_key } });
  assert.equal(noHeader.statusCode, 403);
  assert.equal((await gw.app.inject({ method: "GET", url: "/dashboard/api/me" })).statusCode, 401);
  assert.equal((await gw.app.inject({ method: "GET", url: "/dashboard/api/me", headers: { cookie: "bizhub_session=forged" } })).statusCode, 401);
});

test("repeated wrong passwords lock the login for that email", async () => {
  const m = await createMerchant(gw);
  const owner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  await owner("POST", "/users", { email: "a@shop.th", name: "A", role: "cashier" });
  const attempt = () =>
    gw.app.inject({ method: "POST", url: "/dashboard/api/login", payload: { email: "a@shop.th", password: "wrong-pass-1" }, headers: { "x-requested-with": "bizhub-web" } });
  for (let i = 0; i < 5; i++) assert.equal((await attempt()).statusCode, 401);
  assert.equal((await attempt()).statusCode, 429);
});

test("secret-key owner can create links, search them and see them in the summary", async () => {
  const m = await createMerchant(gw);
  const call = await webLogin(gw, "dashboard", { secret_key: m.test_secret_key });
  const me = (await call("GET", "/me")).json();
  assert.equal(me.livemode, false);
  assert.equal(me.user.role, "owner");
  assert.ok(me.webhook_secret);

  const pay = (await call("POST", "/payments", { amount: 25000, method: "promptpay", reference: "INV-77", description: "ลาเต้" })).json();
  assert.equal((await call("GET", "/payments?q=INV-77")).json().data.length, 1);
  assert.equal((await call("GET", "/payments?q=%25")).json().data.length, 0, "LIKE wildcards are escaped");
  assert.equal((await call("POST", `/payments/${pay.id}/approve`)).statusCode, 200);
  const s = (await call("GET", "/summary")).json();
  assert.equal(s.today.amount, 25000);
  assert.equal(s.daily.at(-1).amount, 25000);
});

test("new staff must replace their temporary password before doing anything", async () => {
  const m = await createMerchant(gw);
  const owner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  const created = (await owner("POST", "/users", { email: "new@shop.th", name: "New", role: "manager" })).json();
  assert.match(created.temporary_password, /\S{10,}/);
  const call = await webLogin(gw, "dashboard", { email: "new@shop.th", password: created.temporary_password });
  assert.equal((await call("GET", "/me")).json().user.must_change_password, true);
  assert.equal((await call("GET", "/payments")).json().error.code, "password_change_required");
  const weak = await call("POST", "/password", { current_password: created.temporary_password, new_password: "short" });
  assert.equal(weak.statusCode, 400);
  assert.equal((await call("POST", "/password", { current_password: created.temporary_password, new_password: "Str0ngPassword" })).statusCode, 200);
  assert.equal((await call("GET", "/payments")).statusCode, 200);
});

test("roles: cashier reviews slips but cannot export, cancel or manage staff; accountant only views and exports", async () => {
  const m = await createMerchant(gw);
  const owner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  const cashier = await staff(gw, owner, "cashier", "c@shop.th");
  const accountant = await staff(gw, owner, "accountant", "acc@shop.th");

  const pay = (await cashier("POST", "/payments", { amount: 10000, method: "promptpay" })).json();
  await uploadSlip(pay.id);
  assert.equal((await cashier("GET", "/payments/export")).statusCode, 403);
  assert.equal((await cashier("GET", "/users")).statusCode, 403);
  assert.equal((await cashier("GET", "/audit")).statusCode, 403);
  assert.equal((await cashier("POST", `/payments/${pay.id}/cancel`)).statusCode, 403);
  assert.equal((await cashier("POST", `/payments/${pay.id}/approve`)).json().status, "succeeded");
  assert.equal((await cashier("GET", "/me")).json().webhook_secret, null);

  assert.equal((await accountant("POST", "/payments", { amount: 10000, method: "promptpay" })).statusCode, 403);
  assert.equal((await accountant("POST", `/payments/${pay.id}/approve`)).statusCode, 403);
  const csv = await accountant("GET", "/payments/export?format=csv");
  assert.equal(csv.statusCode, 200);
  assert.match(String(csv.headers["content-disposition"]), /attachment; filename="payments-live-.*\.csv"/);
  assert.ok(csv.rawPayload.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "CSV starts with a UTF-8 BOM");
  assert.match(csv.body, /สำเร็จ/);
});

test("export to xlsx respects date range and status, and is audited", async () => {
  const m = await createMerchant(gw);
  const owner = await webLogin(gw, "dashboard", { secret_key: m.test_secret_key });
  for (let i = 0; i < 3; i++) await owner("POST", "/payments", { amount: 10000 + i, method: "promptpay", reference: "R" + i });
  gw.db.prepare("UPDATE payments SET created_at = ? WHERE reference = 'R0'").run("2020-01-01T00:00:00.000Z");

  const xlsx = await owner("GET", "/payments/export?format=xlsx");
  assert.equal(xlsx.statusCode, 200);
  assert.equal(xlsx.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(xlsx.rawPayload.subarray(0, 2).toString(), "PK");

  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const ranged = await owner("GET", `/payments/export?format=csv&from=${today}&to=${today}`);
  assert.equal(ranged.body.trim().split("\r\n").length, 1 + 2, "header + the two payments created today");
  const none = await owner("GET", "/payments/export?format=csv&status=succeeded");
  assert.equal(none.body.trim().split("\r\n").length, 1);

  const log = (await owner("GET", "/audit")).json().data;
  assert.ok(log.some((e: any) => e.action === "payments.export" && e.details.format === "xlsx"));
});

test("staff can switch live/test data; a secret-key session cannot", async () => {
  const m = await createMerchant(gw);
  const owner = await webLogin(gw, "dashboard", { secret_key: m.test_secret_key });
  assert.equal((await owner("POST", "/mode", { livemode: true })).statusCode, 400);
  const mgr = await staff(gw, owner, "manager", "m@shop.th");
  await owner("POST", "/payments", { amount: 10000, method: "promptpay" });
  assert.equal((await mgr("GET", "/payments")).json().data.length, 0, "staff start on live data");
  await mgr("POST", "/mode", { livemode: false });
  assert.equal((await mgr("GET", "/payments")).json().data.length, 1);
});

test("deactivating or resetting a staff member signs them out; the last owner cannot be removed", async () => {
  const m = await createMerchant(gw);
  const keyOwner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  const ownerUser = await staff(gw, keyOwner, "owner", "boss@shop.th");
  const cashier = await staff(gw, keyOwner, "cashier", "c@shop.th");
  const list = (await ownerUser("GET", "/users")).json().data;
  const cashierId = list.find((u: any) => u.email === "c@shop.th").id;
  const bossId = list.find((u: any) => u.email === "boss@shop.th").id;

  await ownerUser("POST", `/users/${cashierId}/reset-password`);
  assert.equal((await cashier("GET", "/me")).statusCode, 401);

  const demote = await ownerUser("PATCH", `/users/${bossId}`, { role: "manager" });
  assert.equal(demote.statusCode, 409);
  assert.equal(demote.json().error.code, "last_owner");

  const audit = (await ownerUser("GET", "/audit")).json().data.map((e: any) => e.action);
  assert.ok(audit.includes("user.create"));
  assert.ok(audit.includes("user.reset_password"));
});

test("sessions are scoped to their merchant and die with key rotation or merchant deactivation", async () => {
  const a = await createMerchant(gw, "A");
  const b = await createMerchant(gw, "B");
  const callA = await webLogin(gw, "dashboard", { secret_key: a.test_secret_key });
  const payA = (await callA("POST", "/payments", { amount: 10000, method: "promptpay" })).json();
  const callB = await webLogin(gw, "dashboard", { secret_key: b.test_secret_key });
  assert.equal((await callB("GET", `/payments/${payA.id}`)).statusCode, 404);
  const staffB = await staff(gw, callB, "manager", "mgr@b.th");
  assert.equal((await staffB("GET", "/users")).statusCode, 403);
  const userA = (await callA("POST", "/users", { email: "x@a.th", name: "X", role: "cashier" })).json();
  assert.equal((await callB("PATCH", `/users/${userA.id}`, { active: false })).statusCode, 404, "cannot touch another shop's staff");

  await gw.app.inject({ method: "POST", url: `/admin/merchants/${a.id}/rotate-keys`, headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal((await callA("GET", "/me")).statusCode, 401);
  await gw.app.inject({ method: "PATCH", url: `/admin/merchants/${b.id}`, headers: { authorization: `Bearer ${ADMIN}` }, payload: { active: false } });
  assert.equal((await staffB("GET", "/me")).statusCode, 401);
});

test("review flow: slip waiting for review shows up and can be rejected", async () => {
  const m = await createMerchant(gw);
  const live = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  const pay = (await live("POST", "/payments", { amount: 10000, method: "promptpay" })).json();
  await uploadSlip(pay.id);
  assert.equal((await live("GET", "/summary")).json().awaiting_review, 1);
  const detail = (await live("GET", `/payments/${pay.id}`)).json();
  assert.equal(detail.slip_checks.length, 1);
  assert.equal((await live("GET", `/payments/${pay.id}/slip`)).headers["content-type"], "image/png");
  assert.equal((await live("POST", `/payments/${pay.id}/reject`, { reason: "ไม่พบยอดเข้า" })).json().status, "failed");
});

test("logout ends the session", async () => {
  const m = await createMerchant(gw);
  const call = await webLogin(gw, "dashboard", { secret_key: m.test_secret_key });
  await call("POST", "/logout");
  assert.equal((await call("GET", "/me")).statusCode, 401);
});
