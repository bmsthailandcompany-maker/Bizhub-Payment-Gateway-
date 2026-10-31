import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPromptPayPayload, crc16, isValidPromptPayId } from "../src/promptpay.ts";

// Expected values cross-checked against the reference `promptpay-qr` npm package.
test("crc16 matches CRC-16/CCITT-FALSE check value", () => {
  assert.equal(crc16("123456789"), "29B1");
});

test("static QR for a mobile number", () => {
  assert.equal(
    buildPromptPayPayload("080-123-4567"),
    "00020101021129370016A000000677010111011300668012345675802TH530376463046197",
  );
});

test("dynamic QR with amount for a mobile number", () => {
  assert.equal(
    buildPromptPayPayload("0812345678", 422),
    "00020101021229370016A000000677010111011300668123456785802TH530376454044.2263045D49",
  );
});

test("dynamic QR for a national/tax ID", () => {
  assert.equal(
    buildPromptPayPayload("1234567890123", 150000),
    "00020101021229370016A000000677010111021312345678901235802TH530376454071500.0063048F60",
  );
});

test("rejects malformed IDs", () => {
  assert.equal(isValidPromptPayId("12345"), false);
  assert.equal(isValidPromptPayId("1812345678"), false);
  assert.equal(isValidPromptPayId("0812345678"), true);
});
