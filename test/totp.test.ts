import assert from "node:assert/strict";
import { test } from "node:test";
import { base32Decode, base32Encode, newRecoveryCodes, totpAt, verifyTotp } from "../src/auth/totp.ts";

// RFC 6238 Appendix B (SHA1 secret "12345678901234567890"), last 6 of the 8-digit values.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

test("base32 round-trips and matches the RFC 4648 alphabet", () => {
  assert.equal(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Decode(RFC_SECRET).toString(), "12345678901234567890");
});

test("TOTP matches RFC 6238 test vectors", () => {
  const cases: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ];
  for (const [t, expected] of cases) {
    assert.equal(totpAt(RFC_SECRET, Math.floor(t / 30), 8), expected, `t=${t}`);
    assert.equal(totpAt(RFC_SECRET, Math.floor(t / 30)), expected.slice(-6));
  }
});

test("verify accepts ±1 step of drift and refuses replays", () => {
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), null, now), step);
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), null, now), step - 1);
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), null, now), null);
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), step, now), null, "same code twice is refused");
  assert.equal(verifyTotp(RFC_SECRET, "12345", null, now), null);
});

test("recovery codes are unique and readable", () => {
  const codes = newRecoveryCodes();
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z2-9]{4}-[a-z2-9]{4}$/);
});
