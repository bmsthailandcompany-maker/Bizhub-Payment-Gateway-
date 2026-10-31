import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Gateway } from "../src/app.ts";
import { ADMIN, type Call, makeGateway, webLogin } from "./helpers.ts";

let gw: Gateway;
let cleanup: () => Promise<void>;
let root: Call;

beforeEach(async () => {
  ({ gw, cleanup } = await makeGateway());
  root = await webLogin(gw, "admin", { admin_token: ADMIN });
});
afterEach(() => cleanup());

async function adminAccount(role: string, email: string): Promise<Call> {
  const created = await root("POST", "/admins", { email, name: role, role });
  assert.equal(created.statusCode, 201, created.body);
  const temp = created.json().temporary_password;
  const call = await webLogin(gw, "admin", { email, password: temp });
  assert.equal((await call("POST", "/password", { current_password: temp, new_password: "Adm1nPassword" })).statusCode, 200);
  return call;
}

test("console page and login", async () => {
  assert.equal((await gw.app.inject({ method: "GET", url: "/admin/console" })).statusCode, 200);
  const bad = await gw.app.inject({ method: "POST", url: "/admin/console/api/login", payload: { admin_token: "nope" }, headers: { "x-requested-with": "bizhub-web" } });
  assert.equal(bad.statusCode, 401);
  const me = (await root("GET", "/me")).json();
  assert.equal(me.user.role, "superadmin");
  assert.ok(me.permissions.includes("admins.manage"));
});

test("operator onboards a merchant with an owner account who can then sign in", async () => {
  const ops = await adminAccount("operator", "ops@gw.th");
  const created = await ops("POST", "/merchants", { name: "ร้านใหม่", promptpay_id: "0812345678" });
  assert.equal(created.statusCode, 201, created.body);
  const m = created.json();
  assert.match(m.live_secret_key, /^sk_live_/);
  const owner = (await ops("POST", `/merchants/${m.id}/users`, { email: "owner@new.th", name: "เจ้าของ", role: "owner" })).json();

  const login = await gw.app.inject({
    method: "POST",
    url: "/dashboard/api/login",
    payload: { email: "owner@new.th", password: owner.temporary_password },
    headers: { "x-requested-with": "bizhub-web" },
  });
  assert.equal(login.statusCode, 200);

  const list = (await ops("GET", "/merchants")).json().data;
  assert.equal(list[0].staff, 1);
  const detail = (await ops("GET", `/merchants/${m.id}`)).json();
  assert.equal(detail.users[0].email, "owner@new.th");
  assert.equal(detail.api_keys.length, 2);
});

test("support is read-only; operator cannot manage admins", async () => {
  const support = await adminAccount("support", "help@gw.th");
  const ops = await adminAccount("operator", "ops@gw.th");
  const m = (await ops("POST", "/merchants", { name: "S" })).json();
  assert.equal((await support("GET", "/merchants")).statusCode, 200);
  assert.equal((await support("POST", "/merchants", { name: "X" })).statusCode, 403);
  assert.equal((await support("POST", `/merchants/${m.id}/rotate-keys`)).statusCode, 403);
  assert.equal((await support("GET", "/payments/export")).statusCode, 403);
  assert.equal((await support("GET", "/audit")).statusCode, 403);
  assert.equal((await ops("GET", "/admins")).statusCode, 403);
  assert.equal((await ops("POST", "/admins", { email: "x@gw.th", name: "x", role: "superadmin" })).statusCode, 403);
});

test("gateway-wide payments, summary and export include every merchant", async () => {
  const a = (await root("POST", "/merchants", { name: "A", promptpay_id: "0812345678" })).json();
  const b = (await root("POST", "/merchants", { name: "B", promptpay_id: "0812345679" })).json();
  for (const [key, amount] of [[a.live_secret_key, 10000], [b.live_secret_key, 20000]] as const) {
    const p = await gw.app.inject({ method: "POST", url: "/v1/payments", headers: { authorization: `Bearer ${key}` }, payload: { amount, method: "promptpay" } });
    await gw.app.inject({ method: "POST", url: `/v1/payments/${p.json().id}/approve`, headers: { authorization: `Bearer ${key}` } });
  }
  const s = (await root("GET", "/summary")).json();
  assert.equal(s.today.amount, 30000);
  assert.equal(s.top_merchants[0].name, "B");
  assert.equal((await root("GET", "/payments")).json().data.length, 2);
  assert.equal((await root("GET", `/payments?merchant_id=${a.id}`)).json().data.length, 1);
  assert.equal((await root("GET", "/payments?livemode=false")).json().data.length, 0);

  const csv = await root("GET", "/payments/export?format=csv");
  const lines = csv.body.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^﻿?ร้านค้า,รหัสร้าน/);
});

test("admin accounts: last superadmin is protected and deactivation signs out", async () => {
  const sa = await adminAccount("superadmin", "sa@gw.th");
  const ops = await adminAccount("operator", "ops@gw.th");
  const admins = (await sa("GET", "/admins")).json().data;
  const saId = admins.find((u: any) => u.email === "sa@gw.th").id;
  const opsId = admins.find((u: any) => u.email === "ops@gw.th").id;
  assert.equal((await sa("PATCH", `/admins/${saId}`, { active: false })).json().error.code, "last_owner");
  await sa("PATCH", `/admins/${opsId}`, { active: false });
  assert.equal((await ops("GET", "/me")).statusCode, 401);
  const log = (await sa("GET", "/audit")).json().data.map((e: any) => e.action);
  assert.ok(log.includes("admin_user.update"));
  assert.ok(log.includes("admin.login"));
});

test("failed webhooks are listed and can be retried", async () => {
  const m = (await root("POST", "/merchants", { name: "W", promptpay_id: "0812345678", webhook_url: "https://shop.example/hook" })).json();
  await gw.app.inject({ method: "POST", url: "/v1/payments", headers: { authorization: `Bearer ${m.test_secret_key}` }, payload: { amount: 10000, method: "promptpay" } });
  gw.db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = 8").run();
  const failed = (await root("GET", "/webhooks?status=failed")).json().data;
  assert.equal(failed.length, 1);
  assert.equal((await root("GET", "/summary?livemode=false")).json().failed_webhooks, 1);
  assert.equal((await root("POST", `/webhooks/${failed[0].id}/retry`)).json().status, "pending");
});

test("ADMIN_TOKEN sessions die when the token changes", async () => {
  gw.db.prepare("UPDATE sessions SET api_key_id = 'old-token-hash' WHERE kind = 'admin'").run();
  assert.equal((await root("GET", "/me")).statusCode, 401);
});
