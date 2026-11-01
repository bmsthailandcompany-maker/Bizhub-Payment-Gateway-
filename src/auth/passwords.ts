import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

/** Format: scrypt$N$r$p$<salt b64>$<hash b64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

/** Used to keep login timing the same whether or not the account exists. */
export const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(KEYLEN).toString("base64");

/** Returns a Thai error message, or null when the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < 6) return "รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร";
  if (password.length > 200) return "รหัสผ่านยาวเกินไป";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "รหัสผ่านต้องมีทั้งตัวอักษรและตัวเลข";
  return null;
}

/** Readable one-time password for new accounts and resets (user must change it at first sign-in). */
export function temporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(14);
  let out = "";
  for (let i = 0; i < 14; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out.slice(0, 7) + "-" + out.slice(7) + "1a";
}
