import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadVapidKeys, type PushSubscriptionInput } from "../src/services/push.ts";
import { createMerchant, makeGateway, staff, webLogin } from "./helpers.ts";

const sub = (n: string): PushSubscriptionInput => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: "BPk" + n, auth: "au" + n } });
const settle = () => new Promise((r) => setTimeout(r, 30));

test("staff get a push when money arrives or a slip waits; live only, role and choices respected", async () => {
  const sent: { endpoint: string; msg: { title: string; url: string } }[] = [];
  let gone = new Set<string>();
  const { gw, cleanup } = await makeGateway({
    pushSender: async (s, payload) => {
      if (gone.has(s.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 });
      sent.push({ endpoint: s.endpoint, msg: JSON.parse(payload) });
    },
  });
  try {
    const m = await createMerchant(gw);
    const owner = await webLogin(gw, "dashboard", { secret_key: m.live_secret_key });
    const manager = await staff(gw, owner, "manager", "mgr@shop.th");
    const accountant = await staff(gw, owner, "accountant", "acc@shop.th");

    // The server hands out its public key; secret-key sessions cannot subscribe a device.
    const info = (await manager("GET", "/push")).json();
    assert.match(info.public_key, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal((await owner("POST", "/push", { subscription: sub("owner"), events: ["paid"] })).statusCode, 400);

    assert.equal((await manager("POST", "/push", { subscription: sub("mgr"), events: ["paid", "review"] })).statusCode, 200);
    assert.equal((await accountant("POST", "/push", { subscription: sub("acc"), events: ["review"] })).statusCode, 200);
    assert.deepEqual((await manager("GET", `/push?endpoint=${encodeURIComponent(sub("mgr").endpoint)}`)).json().subscription, { events: ["paid", "review"] });
    assert.equal((await manager("POST", "/push", { subscription: { ...sub("x"), endpoint: "http://insecure.example.com" }, events: [] })).statusCode, 400);

    const auth = (k: string) => ({ authorization: `Bearer ${k}` });
    const create = async (key: string, amount: number) =>
      (await gw.app.inject({ method: "POST", url: "/v1/payments", headers: auth(key), payload: { amount, method: "promptpay", reference: "INV-9" } })).json();

    // Money in (live): only the manager chose "paid".
    const p = await create(m.live_secret_key, 15000);
    gw.payments.transition(p.id, "succeeded", { confirmed_by: "manual" });
    await settle();
    assert.deepEqual(sent.map((s) => s.endpoint), [sub("mgr").endpoint]);
    assert.match(sent[0].msg.title, /เงินเข้า ฿150\.00/);
    assert.equal(sent[0].msg.url, "/dashboard#payments");

    // A slip to check: both chose "review".
    sent.length = 0;
    const q = await create(m.live_secret_key, 2000);
    gw.payments.transition(q.id, "awaiting_review");
    await settle();
    assert.deepEqual(sent.map((s) => s.endpoint).sort(), [sub("acc").endpoint, sub("mgr").endpoint].sort());
    assert.equal(sent[0].msg.url, "/dashboard#review");

    // Test-mode payments never notify.
    sent.length = 0;
    const t = await create(m.test_secret_key, 100);
    gw.payments.transition(t.id, "succeeded", { confirmed_by: "manual" });
    await settle();
    assert.equal(sent.length, 0);

    // A staff account that was switched off gets nothing, even with a subscription still on file.
    gw.db.prepare("UPDATE merchant_users SET active = 0 WHERE email = 'mgr@shop.th'").run();
    const r = await create(m.live_secret_key, 500);
    gw.payments.transition(r.id, "succeeded", { confirmed_by: "manual" });
    await settle();
    assert.equal(sent.length, 0);

    // A subscription the browser dropped (410) is removed; test pushes work; unsubscribe removes the device.
    gone = new Set([sub("acc").endpoint]);
    assert.equal((await accountant("POST", "/push/test", { endpoint: sub("acc").endpoint })).statusCode, 502);
    assert.equal((gw.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?").get(sub("acc").endpoint) as { n: number }).n, 0);
    gone = new Set();
    gw.db.prepare("UPDATE merchant_users SET active = 1 WHERE email = 'mgr@shop.th'").run();
    assert.equal((await manager("POST", "/push/test", { endpoint: sub("mgr").endpoint })).statusCode, 200);
    assert.equal((await manager("POST", "/push/unsubscribe", { endpoint: sub("mgr").endpoint })).statusCode, 200);
    assert.equal((gw.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n, 0);
  } finally {
    await cleanup();
  }
});

test("VAPID keys are made once and kept in DATA_DIR; env keys win", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vapid-"));
  const a = loadVapidKeys(dir, {});
  const b = loadVapidKeys(dir, {});
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(fs.statSync(path.join(dir, "vapid.json")).mode & 0o077, 0, "private key file is not world-readable");
  const env = loadVapidKeys(dir, { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:x@y.z" });
  assert.deepEqual(env, { publicKey: "pub", privateKey: "priv", subject: "mailto:x@y.z" });
});

test("the service worker shows pushes and opens the dashboard when tapped", async () => {
  const { gw, cleanup } = await makeGateway();
  try {
    const sw = (await gw.app.inject({ method: "GET", url: "/sw.js" })).body;
    assert.match(sw, /addEventListener\("push"/);
    assert.match(sw, /showNotification/);
    assert.match(sw, /addEventListener\("notificationclick"/);
  } finally {
    await cleanup();
  }
});
