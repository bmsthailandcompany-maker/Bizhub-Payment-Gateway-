import assert from "node:assert/strict";
import { test } from "node:test";
import { EasySlipVerifier } from "../src/slip/easyslip.ts";
import { SlipOkVerifier } from "../src/slip/slipok.ts";


function fetchReturning(status: number, body: unknown, seen: { url?: string; headers?: any; form?: FormData } = {}) {
  return (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.headers = init.headers;
    seen.form = init.body as FormData;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("SlipOK: successful response is normalized", async () => {
  const seen: any = {};
  const v = new SlipOkVerifier(
    "12345",
    "key",
    fetchReturning(
      200,
      {
        success: true,
        data: {
          success: true,
          transRef: "015073144041ATF00999",
          transTimestamp: "2026-10-28T03:04:05.000Z",
          amount: 150.5,
          sendingBank: "004",
          sender: { displayName: "นาย ก", account: { value: "xxx-x-x1234-x" } },
          receiver: { displayName: "บจก. บ้านสวน", account: { value: "xxx-x-x6789-x" }, proxy: { type: "MSISDN", value: "xxx-xxx-5678" } },
        },
      },
      seen,
    ),
  );
  const r = await v.check(Buffer.from("img"), "image/png");
  assert.equal(seen.url, "https://api.slipok.com/api/line/apikey/12345");
  assert.equal(seen.headers["x-authorization"], "key");
  assert.ok(seen.form.get("files"));
  assert.equal(r.kind, "slip");
  if (r.kind !== "slip") return;
  assert.equal(r.slip.amount, 15050);
  assert.equal(r.slip.transRef, "015073144041ATF00999");
  assert.equal(r.slip.receiver.proxy, "xxx-xxx-5678");
  assert.equal(r.slip.receiver.account, "xxx-x-x6789-x");
});

test("SlipOK: error codes map to invalid / retry", async () => {
  const check = (code: number, data?: unknown) =>
    new SlipOkVerifier("1", "k", fetchReturning(400, { code, message: "x", data })).check(Buffer.from(""), "image/png");
  assert.deepEqual(await check(1011), { kind: "invalid", reason: "transfer_not_found" });
  assert.deepEqual(await check(1007), { kind: "invalid", reason: "qr_not_found" });
  assert.deepEqual(await check(1010, { delay: 3 }), { kind: "retry", reason: "bank_delay", retryAfterSeconds: 180 });
  assert.equal((await check(1004)).kind, "retry");
});

test("EasySlip: successful response is normalized", async () => {
  const seen: any = {};
  const v = new EasySlipVerifier(
    "tok",
    undefined,
    fetchReturning(
      200,
      {
        status: 200,
        data: {
          transRef: "68370160657749I376388B35",
          date: "2026-10-28T10:00:00+07:00",
          amount: { amount: 1000, local: { amount: 0, currency: "" } },
          sender: { bank: { id: "004", short: "KBANK" }, account: { name: { th: "นาย ข" } } },
          receiver: {
            bank: { id: "014", short: "SCB" },
            account: { name: { th: "บจก. บ้านสวน" }, bank: { type: "BANKAC", account: "xxx-x-x6789-x" }, proxy: { type: "MSISDN", account: "xxx-xxx-5678" } },
          },
        },
      },
      seen,
    ),
  );
  const r = await v.check(Buffer.from("img"), "image/jpeg");
  assert.equal(seen.url, "https://developer.easyslip.com/api/v1/verify");
  assert.equal(seen.headers.Authorization, "Bearer tok");
  assert.ok(seen.form.get("file"));
  assert.equal(r.kind, "slip");
  if (r.kind !== "slip") return;
  assert.equal(r.slip.amount, 100000);
  assert.equal(r.slip.paidAt, "2026-10-28T03:00:00.000Z");
  assert.equal(r.slip.receiver.account, "xxx-x-x6789-x");
  assert.equal(r.slip.sender.bank, "KBANK");
});

test("EasySlip: errors map to invalid / retry", async () => {
  const check = (status: number, message: string) =>
    new EasySlipVerifier("t", undefined, fetchReturning(status, { status, message })).check(Buffer.from(""), "image/png");
  assert.deepEqual(await check(404, "slip_not_found"), { kind: "invalid", reason: "transfer_not_found" });
  assert.deepEqual(await check(400, "qrcode_not_found"), { kind: "invalid", reason: "qr_not_found" });
  assert.equal((await check(403, "quota_exceeded")).kind, "retry");
  assert.equal((await check(500, "server_error")).kind, "retry");
});
