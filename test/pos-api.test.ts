import assert from "node:assert/strict";
import { test } from "node:test";
import { createMerchant, makeGateway } from "./helpers.ts";

test("POS API: bad ids are 4xx, not server errors; test keys see only test data", async () => {
  const { gw, cleanup } = await makeGateway();
  try {
    const m = await createMerchant(gw, "ร้าน POS");
    const call = (key: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
      gw.app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, payload: payload as object });
    const p = (await call(m.live_secret_key, "POST", "/v1/pos/products", { name: "กาแฟ", priceSatang: 5000 })).json();
    const missing = await call(m.live_secret_key, "POST", "/v1/pos/orders", { items: [{ productId: "00000000-0000-4000-8000-000000000000", quantity: 1 }] });
    assert.equal(missing.statusCode, 404);
    assert.equal((await call(m.test_secret_key, "POST", "/v1/pos/orders", { items: [{ productId: p.id, quantity: 1 }] })).statusCode, 404, "test key cannot use live products");
    const order = (await call(m.live_secret_key, "POST", "/v1/pos/orders", { items: [{ productId: p.id, quantity: 2 }] })).json();
    assert.equal((await call(m.live_secret_key, "POST", `/v1/pos/orders/${order.id}/confirm-cash`)).statusCode, 200);
    assert.equal((await call(m.live_secret_key, "POST", `/v1/pos/orders/${order.id}/confirm-cash`)).statusCode, 409);
    assert.equal((await call(m.live_secret_key, "GET", "/v1/pos/summary")).json().incomeSatang, 10000);
    assert.equal((await call(m.test_secret_key, "GET", "/v1/pos/summary")).json().incomeSatang, 0);
  } finally {
    await cleanup();
  }
});
