import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Gateway } from "../src/app.ts";
import { ADMIN, type Call, makeGateway, webLogin } from "./helpers.ts";

let gw: Gateway;
let cleanup: () => Promise<void>;
afterEach(() => cleanup());

const H = { "x-requested-with": "bizhub-web" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const PDF = Buffer.from("%PDF-1.4 test");

async function signup(extra: Record<string, unknown> = {}): Promise<{ call: Call; merchantId: string }> {
  const res = await gw.app.inject({
    method: "POST",
    url: "/signup/api",
    headers: H,
    payload: { business_name: "ร้านใหม่", contact_name: "สมหญิง", email: "new@shop.th", phone: "0812345678", password: "MyShop2026!", accept_terms: true, ...extra },
  });
  assert.equal(res.statusCode, 201, res.body);
  const session = String(res.headers["set-cookie"]).split(";")[0]!;
  const call: Call = (method, url, payload, more = {}) =>
    gw.app.inject({ method, url: "/dashboard/api" + url, payload: payload as any, headers: { cookie: session, ...H, ...more } });
  return { call, merchantId: res.json().merchant_id };
}

function upload(call: Call, kind: string, file: Buffer, mime = "image/png") {
  const b = "----k";
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="doc"\r\nContent-Type: ${mime}\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return call("POST", "/kyc/documents", body, { "content-type": `multipart/form-data; boundary=${b}` });
}

test("sign-up is closed unless SIGNUP_ENABLED", async () => {
  ({ gw, cleanup } = await makeGateway());
  assert.equal((await gw.app.inject({ method: "GET", url: "/signup" })).statusCode, 404);
  assert.equal((await gw.app.inject({ method: "POST", url: "/signup/api", headers: H, payload: {} })).statusCode, 404);
});

test("a new shop starts in test mode and cannot go live before approval", async () => {
  ({ gw, cleanup } = await makeGateway({}, { signupEnabled: true }));
  assert.equal((await gw.app.inject({ method: "GET", url: "/signup" })).statusCode, 200);
  const weak = await gw.app.inject({ method: "POST", url: "/signup/api", headers: H, payload: { business_name: "x", contact_name: "y", email: "a@b.th", phone: "0812345678", password: "short", accept_terms: true } });
  assert.equal(weak.json().error.code, "weak_password");
  assert.equal((await gw.app.inject({ method: "POST", url: "/signup/api", headers: H, payload: { business_name: "x", contact_name: "y", email: "a@b.th", phone: "0812345678", password: "MyShop2026!", accept_terms: false } })).statusCode, 400);

  const { call, merchantId } = await signup();
  const me = (await call("GET", "/me")).json();
  assert.equal(me.livemode, false);
  assert.equal(me.user.role, "owner");
  assert.equal(me.merchant.kyc.status, "draft");
  assert.equal((await call("POST", "/mode", { livemode: true })).json().error.code, "account_not_approved");

  // Live API keys are refused; test keys work.
  const keys = (await gw.app.inject({ method: "POST", url: `/admin/merchants/${merchantId}/rotate-keys`, headers: { authorization: `Bearer ${ADMIN}` } })).json();
  assert.equal((await gw.app.inject({ method: "GET", url: "/v1/payments", headers: { authorization: `Bearer ${keys.live_secret_key}` } })).json().error.code, "account_not_approved");
  assert.equal((await gw.app.inject({ method: "GET", url: "/v1/payments", headers: { authorization: `Bearer ${keys.test_secret_key}` } })).statusCode, 200);

  const dup = await gw.app.inject({ method: "POST", url: "/signup/api", headers: H, payload: { business_name: "อีก", contact_name: "y", email: "new@shop.th", phone: "0812345678", password: "MyShop2026!", accept_terms: true } });
  assert.equal(dup.json().error.code, "email_taken");
});

test("full verification: profile, documents, submit, admin rejects, shop fixes, admin approves, live opens", async () => {
  ({ gw, cleanup } = await makeGateway({}, { signupEnabled: true }));
  const { call, merchantId } = await signup();
  const submitEarly = await call("POST", "/kyc/submit");
  assert.equal(submitEarly.json().error.code, "kyc_incomplete");

  assert.equal((await call("PATCH", "/kyc", { tax_id: "123" })).json().error.code, "invalid_tax_id");
  assert.equal((await call("PATCH", "/kyc", { business_type: "company", tax_id: "0105555123456", promptpay_id: "0105555123456", bank_name: "กสิกรไทย", bank_account_no: "123-4-56789-0", bank_account_name: "บจก. ร้านใหม่" })).statusCode, 200);
  assert.equal((await upload(call, "id_card", PNG)).statusCode, 201);
  assert.equal((await upload(call, "bank_book", PDF, "application/pdf")).statusCode, 201);
  assert.equal((await upload(call, "id_card", Buffer.from("MZ exe"), "image/png")).statusCode, 400, "bytes must match the type");
  const missing = (await call("GET", "/kyc")).json().missing;
  assert.ok(missing.some((x: string) => x.includes("หนังสือรับรองบริษัท")), "companies also need the company certificate");
  await upload(call, "company_cert", PDF, "application/pdf");
  assert.deepEqual((await call("GET", "/kyc")).json().missing, []);
  assert.equal((await call("POST", "/kyc/submit")).json().kyc.status, "submitted");
  assert.equal((await call("PATCH", "/kyc", { bank_account_no: "999-9-99999-9" })).json().error.code, "kyc_locked", "no edits while under review");

  const root = await webLogin(gw, "admin", { admin_token: ADMIN });
  assert.equal((await root("GET", "/summary")).json().pending_kyc, 1);
  const queue = (await root("GET", "/merchants?kyc=submitted")).json().data;
  assert.equal(queue.length, 1);
  const detail = (await root("GET", `/merchants/${merchantId}`)).json();
  assert.equal(detail.kyc_documents.length, 3);
  const doc = await root("GET", `/merchants/${merchantId}/kyc-documents/${detail.kyc_documents[0].id}`);
  assert.equal(doc.headers["content-type"], "image/png");
  assert.equal((await root("POST", `/merchants/${merchantId}/kyc-review`, { decision: "reject" })).json().error.code, "note_required");
  assert.equal((await root("POST", `/merchants/${merchantId}/kyc-review`, { decision: "reject", note: "สมุดบัญชีไม่ชัด" })).json().kyc.status, "rejected");

  const afterReject = (await call("GET", "/kyc")).json();
  assert.equal(afterReject.merchant.kyc.note, "สมุดบัญชีไม่ชัด");
  const bankBook = afterReject.documents.find((d: any) => d.kind === "bank_book");
  assert.equal((await call("POST", `/kyc/documents/${bankBook.id}/delete`)).statusCode, 200);
  await upload(call, "bank_book", PNG);
  assert.equal((await call("POST", "/kyc/submit")).json().kyc.status, "submitted");
  assert.equal((await root("POST", `/merchants/${merchantId}/kyc-review`, { decision: "approve" })).json().kyc.status, "approved");

  assert.equal((await call("POST", "/mode", { livemode: true })).statusCode, 200);
  assert.equal((await call("GET", "/me")).json().livemode, true);
  assert.equal((await call("PATCH", "/kyc", { bank_account_no: "999-9-99999-9" })).json().error.code, "kyc_locked", "receiving accounts are locked after approval");
  const log = (await root("GET", "/audit")).json().data.map((e: any) => e.action);
  for (const a of ["merchant.signup", "kyc.submitted", "kyc.rejected", "kyc.approved", "kyc.document_viewed"]) assert.ok(log.includes(a), a);
});

test("admin-created shops are approved from the start", async () => {
  ({ gw, cleanup } = await makeGateway());
  const root = await webLogin(gw, "admin", { admin_token: ADMIN });
  const m = (await root("POST", "/merchants", { name: "บริษัทเรา" })).json();
  assert.equal(m.kyc.status, "approved");
});
