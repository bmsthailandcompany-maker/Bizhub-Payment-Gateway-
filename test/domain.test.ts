import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGateway } from "./helpers.ts";

test("the bare domain redirects to the canonical www host; health checks do not", async () => {
  const { gw, cleanup } = await makeGateway({}, { publicBaseUrl: "https://www.bizhubpay.com" });
  try {
    const r = await gw.app.inject({ method: "GET", url: "/dashboard?x=1", headers: { host: "bizhubpay.com" } });
    assert.equal(r.statusCode, 301);
    assert.equal(r.headers.location, "https://www.bizhubpay.com/dashboard?x=1");
    assert.equal((await gw.app.inject({ method: "GET", url: "/health", headers: { host: "bizhubpay.com" } })).statusCode, 200);
    assert.equal((await gw.app.inject({ method: "GET", url: "/health", headers: { host: "www.bizhubpay.com" } })).statusCode, 200);
    assert.equal((await gw.app.inject({ method: "GET", url: "/dashboard", headers: { host: "www.bizhubpay.com" } })).statusCode, 200);
  } finally {
    await cleanup();
  }
});
