import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { buildApp, type AppDeps, type Gateway } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";

export const ADMIN = "admin-token-for-tests-only";

export async function makeGateway(
  deps: Partial<AppDeps> = {},
  config: Partial<Config> = {},
): Promise<{ gw: Gateway; cleanup: () => Promise<void> }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bizhub-"));
  const gw = await buildApp(
    { port: 0, publicBaseUrl: "https://pay.example.com", adminToken: ADMIN, dataDir, defaultPaymentTtlSeconds: 900, omise: null, slipVerifier: null, workerIntervalMs: 0, requireAdmin2fa: false, ...config },
    { db: openDb(":memory:"), fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch, logger: false, ...deps },
  );
  return {
    gw,
    cleanup: async () => {
      await gw.app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function createMerchant(gw: Gateway, name = "ร้านทดสอบ") {
  const res = await gw.app.inject({
    method: "POST",
    url: "/admin/merchants",
    headers: { authorization: `Bearer ${ADMIN}` },
    payload: { name, promptpay_id: "0812345678" },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; test_secret_key: string; live_secret_key: string };
}

export type Call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, extra?: Record<string, string>) => Promise<LightMyRequestResponse>;

/** Signs in to one of the web apps and returns a caller bound to that session cookie. */
export async function webLogin(gw: Gateway, app: "dashboard" | "admin", body: Record<string, string>): Promise<Call> {
  const base = app === "dashboard" ? "/dashboard/api" : "/admin/console/api";
  const res = await gw.app.inject({ method: "POST", url: base + "/login", payload: body, headers: { "x-requested-with": "bizhub-web" } });
  assert.equal(res.statusCode, 200, res.body);
  const cookie = String(res.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const session = cookie.split(";")[0]!;
  return (method, url, payload, extra = {}) =>
    gw.app.inject({ method, url: base + url, payload: payload as any, headers: { cookie: session, "x-requested-with": "bizhub-web", ...extra } });
}

/** Creates a staff account through the owner's session and completes the forced password change. */
export async function staff(gw: Gateway, owner: Call, role: string, email: string): Promise<Call> {
  const created = await owner("POST", "/users", { email, name: role, role });
  assert.equal(created.statusCode, 201, created.body);
  const temp = created.json().temporary_password as string;
  const call = await webLogin(gw, "dashboard", { email, password: temp });
  const changed = await call("POST", "/password", { current_password: temp, new_password: "NewPassw0rd!" });
  assert.equal(changed.statusCode, 200, changed.body);
  return call;
}
