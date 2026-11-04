import assert from "node:assert/strict";
import { test } from "node:test";
import { compareMasked, evaluateSlip, promptPayCandidates } from "../src/slip/evaluate.ts";
import type { VerifiedSlip } from "../src/slip/types.ts";

test("compareMasked aligns masked numbers from the right", () => {
  assert.equal(compareMasked("xxx-x-x6789-x", "1234567890"), "match");
  assert.equal(compareMasked("xxx-x-x6788-x", "1234567890"), "mismatch");
  assert.equal(compareMasked("xxx-xxx-5678", "0812345678"), "match");
  assert.equal(compareMasked("xxx-xxx-xxxx", "0812345678"), "unknown");
  assert.equal(compareMasked("x-xx", "0812345678"), "unknown");
});

test("PromptPay mobile numbers match in local and international form", () => {
  const c = promptPayCandidates("081-234-5678");
  assert.ok(c.includes("66812345678"));
  assert.ok(c.some((x) => compareMasked("0066-8xx-xxx-678", x) === "match"));
});

const base: VerifiedSlip = {
  transRef: "T1",
  amount: 10000,
  paidAt: new Date().toISOString(),
  receiver: { name: null, proxy: null, account: "xxx-x-x6789-x" },
  sender: { name: null, bank: null },
  raw: null,
};
const target = {
  method: "promptpay" as const,
  amount: 10000,
  createdAt: new Date().toISOString(),
  promptpayId: "0812345678",
  bankAccountNo: "999-9-99999-9",
};

test("PromptPay: an unrecognised receiving account is left for review, not rejected", () => {
  assert.deepEqual(evaluateSlip(base, target), { outcome: "needs_review", reason: "receiver_unverifiable" });
});

test("bank transfer: a conflicting receiving account is rejected", () => {
  assert.deepEqual(evaluateSlip(base, { ...target, method: "bank_transfer" }), {
    outcome: "rejected",
    reason: "receiver_mismatch",
  });
});

test("missing slip date needs review", () => {
  assert.equal(evaluateSlip({ ...base, paidAt: null }, target).outcome, "needs_review");
});
