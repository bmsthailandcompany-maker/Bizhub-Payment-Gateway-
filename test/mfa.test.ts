import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Gateway } from "../src/app.ts";
import { currentStep, totpAt } from "../src/auth/totp.ts";
import { ADMIN, type Call, createMerchant, makeGateway, staff, webLogin } from "./helpers.ts";

let gw: Gateway;
let cleanup: () => Promise<void>;
afterEach(() => cleanup());

const H = { "x-requested-with": "bizhub-web" };
const now = (secret: string, offset = 0) => totpAt(secret, currentStep() + offset);

/** Enrols the signed-in user and returns the secret and recovery codes. */
async function enrol(call: Call) {
  const setup = await call("POST", "/2fa/setup");
  assert.equal(setup.statusCode, 200, setup.body);
  const { secret, uri, qr } = setup.json();
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(qr, /^data:image\/png;base64,/);
  assert.equal((await call("POST", "/2fa/confirm", { code: "000000" })).statusCode, 400);
  const confirmed = await call("POST", "/2fa/confirm", { code: now(secret) });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  return { secret: secret as string, recovery: confirmed.json().recovery_codes as string[] };
}

function login(app: "dashboard" | "admin", body: Record<string, string>) {
  const base = app === "dashboard" ? "/dashboard/api" : "/admin/console/api";
  return gw.app.inject({ method: "POST", url: base + "/login", payload: body, headers: H });
}
function login2fa(app: "dashboard" | "admin", mfa_token: string, code: string) {
  const base = app === "dashboard" ? "/dashboard/api" : "/admin/console/api";
  return gw.app.inject({ method: "POST", url: base + "/login/2fa", payload: { mfa_token, code }, headers: H });
}

test("staff 2FA: password alone no longer signs in; code or recovery code does, once each", async () => {
  ({ gw, cleanup } = await makeGateway());
  const m = await createMerchant(gw);
  const owner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  const cashier = await staff(gw, owner, "cashier", "c@shop.th");
  const { secret, recovery } = await enrol(cashier);
  assert.equal(recovery.length, 10);
  assert.equal((await cashier("GET", "/me")).json().user.two_factor, true);

  const first = await login("dashboard", { email: "c@shop.th", password: "NewPassw0rd!" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().mfa_required, true);
  assert.equal(first.headers["set-cookie"], undefined, "no session before the second factor");

  assert.equal((await login2fa("dashboard", first.json().mfa_token, "123456")).statusCode, 401);
  const ok = await login2fa("dashboard", first.json().mfa_token, now(secret, 1));
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(String(ok.headers["set-cookie"]), /bizhub_session=/);
  assert.equal((await login2fa("dashboard", first.json().mfa_token, now(secret))).statusCode, 401, "ticket is single-use");

  const second = (await login("dashboard", { email: "c@shop.th", password: "NewPassw0rd!" })).json();
  assert.equal((await login2fa("dashboard", second.mfa_token, now(secret, 1))).statusCode, 401, "the same code cannot be replayed");
  const viaRecovery = await login2fa("dashboard", second.mfa_token, recovery[0]!.toUpperCase());
  assert.equal(viaRecovery.json().used_recovery_code, true);
  const third = (await login("dashboard", { email: "c@shop.th", password: "NewPassw0rd!" })).json();
  assert.equal((await login2fa("dashboard", third.mfa_token, recovery[0]!)).statusCode, 401, "recovery codes are single-use");

  const log = (await owner("GET", "/audit")).json().data;
  assert.ok(log.some((e: any) => e.action === "auth.login" && e.details?.second_factor === "recovery"));
  assert.ok(log.some((e: any) => e.action === "auth.2fa_failed"));
});

test("wrong 2FA codes are rate limited per user", async () => {
  ({ gw, cleanup } = await makeGateway());
  const m = await createMerchant(gw);
  const owner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  const mgr = await staff(gw, owner, "manager", "m@shop.th");
  const { secret } = await enrol(mgr);
  const t = (await login("dashboard", { email: "m@shop.th", password: "NewPassw0rd!" })).json().mfa_token;
  for (let i = 0; i < 5; i++) assert.equal((await login2fa("dashboard", t, "000000")).statusCode, 401);
  assert.equal((await login2fa("dashboard", t, now(secret))).statusCode, 429, "even the right code waits out the lock");
});

test("shop policy forces staff to enrol, blocks turning it off, and a manager can reset a lost phone", async () => {
  ({ gw, cleanup } = await makeGateway());
  const m = await createMerchant(gw);
  const owner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  const cashier = await staff(gw, owner, "cashier", "c@shop.th");
  assert.equal((await owner("PATCH", "/security", { require_2fa: true })).statusCode, 200);

  const blocked = await cashier("GET", "/payments");
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, "mfa_setup_required");
  assert.equal((await cashier("GET", "/me")).json().user.mfa_setup_required, true);
  const { secret } = await enrol(cashier);
  assert.equal((await cashier("GET", "/payments")).statusCode, 200);
  assert.equal((await cashier("POST", "/2fa/disable", { code: now(secret) })).json().error.code, "2fa_required");
  assert.equal((await cashier("PATCH", "/security", { require_2fa: false })).statusCode, 403, "only staff managers set policy");

  const id = (await owner("GET", "/users")).json().data.find((u: any) => u.email === "c@shop.th").id;
  assert.equal((await owner("GET", "/users")).json().data.find((u: any) => u.id === id).two_factor, true);
  assert.equal((await owner("POST", `/users/${id}/reset-2fa`)).statusCode, 200);
  assert.equal((await cashier("GET", "/me")).statusCode, 401, "reset signs the user out");
  const again = await login("dashboard", { email: "c@shop.th", password: "NewPassw0rd!" });
  assert.equal(again.json().mfa_required, undefined, "after a reset the password signs in and enrolment is required again");
});

test("users can rotate recovery codes and turn 2FA off with a valid code", async () => {
  ({ gw, cleanup } = await makeGateway());
  const m = await createMerchant(gw);
  const owner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  const acc = await staff(gw, owner, "accountant", "a@shop.th");
  const { secret, recovery } = await enrol(acc);
  assert.equal((await acc("POST", "/2fa/recovery-codes", { code: now(secret) })).statusCode, 400, "the enrolment code cannot be reused");
  const fresh = (await acc("POST", "/2fa/recovery-codes", { code: now(secret, 1) })).json().recovery_codes;
  assert.equal(fresh.length, 10);
  assert.notDeepEqual(fresh, recovery);
  const t = (await login("dashboard", { email: "a@shop.th", password: "NewPassw0rd!" })).json().mfa_token;
  assert.equal((await login2fa("dashboard", t, recovery[1]!)).statusCode, 401, "old recovery codes stop working");
  assert.equal((await acc("POST", "/2fa/disable", { code: "000000" })).statusCode, 400);
  assert.equal((await acc("POST", "/2fa/disable", { code: fresh[0] })).statusCode, 200);
  assert.equal((await acc("GET", "/2fa")).json().enabled, false);
});

test("secret-key sessions cannot enrol (they are not personal accounts)", async () => {
  ({ gw, cleanup } = await makeGateway());
  const m = await createMerchant(gw);
  const owner = await webLogin(gw, "dashboard", { secret_key: m.test_secret_key });
  assert.equal((await owner("POST", "/2fa/setup")).json().error.code, "not_a_user");
});

test("ADMIN_REQUIRE_2FA forces admin accounts to enrol; admin 2FA login and reset work", async () => {
  ({ gw, cleanup } = await makeGateway({}, { requireAdmin2fa: true }));
  const root = await webLogin(gw, "admin", { admin_token: ADMIN });
  const created = (await root("POST", "/admins", { email: "ops@gw.th", name: "Ops", role: "operator" })).json();
  const ops = await webLogin(gw, "admin", { email: "ops@gw.th", password: created.temporary_password });
  assert.equal((await ops("POST", "/password", { current_password: created.temporary_password, new_password: "Adm1nPassword" })).statusCode, 200);
  assert.equal((await ops("GET", "/merchants")).json().error.code, "mfa_setup_required");
  assert.equal((await ops("GET", "/me")).json().require_admin_2fa, true);
  const { secret } = await enrol(ops);
  assert.equal((await ops("GET", "/merchants")).statusCode, 200);

  const first = (await login("admin", { email: "ops@gw.th", password: "Adm1nPassword" })).json();
  assert.equal(first.mfa_required, true);
  const ok = await login2fa("admin", first.mfa_token, now(secret, 1));
  assert.match(String(ok.headers["set-cookie"]), /bizhub_admin=/);

  const ticketForWrongApp = (await login("admin", { email: "ops@gw.th", password: "Adm1nPassword" })).json().mfa_token;
  assert.equal((await login2fa("dashboard", ticketForWrongApp, now(secret, -1))).statusCode, 401, "admin tickets do not work on the merchant dashboard");

  assert.equal((await root("POST", `/admins/${created.id}/reset-2fa`)).statusCode, 200);
  assert.equal((await ops("GET", "/me")).statusCode, 401);
});

test("an operator can reset a merchant user's 2FA and enforce the shop policy", async () => {
  ({ gw, cleanup } = await makeGateway());
  const root = await webLogin(gw, "admin", { admin_token: ADMIN });
  const m = (await root("POST", "/merchants", { name: "S", promptpay_id: "0812345678" })).json();
  const owner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
  const mgr = await staff(gw, owner, "manager", "m@s.th");
  await enrol(mgr);
  const uid = (await root("GET", `/merchants/${m.id}/users`)).json().data[0].id;
  assert.equal((await root("POST", `/merchants/${m.id}/users/${uid}/reset-2fa`)).statusCode, 200);
  assert.equal((await mgr("GET", "/me")).statusCode, 401);
  assert.equal((await root("PATCH", `/merchants/${m.id}`, { require_2fa: true })).json().require_2fa, true);
});
