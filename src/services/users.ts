import type { Db } from "../db.ts";
import { now } from "../db.ts";
import QRCode from "qrcode";
import { hashPassword, passwordProblem, temporaryPassword, verifyPassword } from "../auth/passwords.ts";
import { newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from "../auth/totp.ts";
import { newId, sha256 } from "../ids.ts";
import { PaymentError } from "./payments.ts";

export type UserScope = "merchant" | "admin";

export interface UserRow {
  id: string;
  merchant_id: string | null;
  email: string;
  name: string;
  role: string;
  password_hash: string;
  must_change_password: number;
  active: number;
  last_login_at: string | null;
  created_at: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
  /** JSON array of sha256 hashes of unused recovery codes. */
  recovery_codes: string | null;
}

const TABLE: Record<UserScope, string> = { merchant: "merchant_users", admin: "admin_users" };

export function serializeUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active === 1,
    must_change_password: u.must_change_password === 1,
    two_factor: u.totp_enabled === 1,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
  };
}

/** Staff accounts for the merchant dashboard and operator accounts for the admin console. */
export class UserService {
  constructor(private readonly db: Db) {}

  get(scope: UserScope, id: string): UserRow | undefined {
    const row = this.db.prepare(`SELECT * FROM ${TABLE[scope]} WHERE id = ?`).get(id) as UserRow | undefined;
    return row && scope === "admin" ? { ...row, merchant_id: null } : row;
  }

  findByEmail(scope: UserScope, email: string): UserRow | undefined {
    const row = this.db.prepare(`SELECT * FROM ${TABLE[scope]} WHERE email = ?`).get(email.trim()) as UserRow | undefined;
    return row && scope === "admin" ? { ...row, merchant_id: null } : row;
  }

  list(scope: UserScope, merchantId?: string): UserRow[] {
    return (
      scope === "merchant"
        ? this.db.prepare("SELECT * FROM merchant_users WHERE merchant_id = ? ORDER BY created_at").all(merchantId!)
        : this.db.prepare("SELECT *, NULL AS merchant_id FROM admin_users ORDER BY created_at").all()
    ) as unknown as UserRow[];
  }

  /** Creates an account with a one-time password the user must change at first sign-in. */
  async create(
    scope: UserScope,
    input: { merchantId?: string; email: string; name: string; role: string },
  ): Promise<{ user: UserRow; temporaryPassword: string }> {
    const email = input.email.trim().toLowerCase();
    if (this.findByEmail(scope, email)) throw new PaymentError(409, "email_taken", "อีเมลนี้มีบัญชีอยู่แล้ว");
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    const id = newId(scope === "merchant" ? "usr" : "adm");
    if (scope === "merchant") {
      this.db
        .prepare(
          "INSERT INTO merchant_users (id, merchant_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, input.merchantId!, email, input.name, input.role, hash, now());
    } else {
      this.db
        .prepare("INSERT INTO admin_users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, email, input.name, input.role, hash, now());
    }
    return { user: this.get(scope, id)!, temporaryPassword: password };
  }

  update(scope: UserScope, id: string, input: { name?: string; role?: string; active?: boolean }): UserRow {
    const u = this.get(scope, id);
    if (!u) throw new PaymentError(404, "not_found", "ไม่พบบัญชีผู้ใช้");
    const willLoseTopRole =
      (input.role !== undefined && input.role !== u.role) || (input.active === false && u.active === 1);
    if (willLoseTopRole) this.assertNotLastTopRole(scope, u);
    this.db
      .prepare(`UPDATE ${TABLE[scope]} SET name = ?, role = ?, active = ? WHERE id = ?`)
      .run(input.name ?? u.name, input.role ?? u.role, input.active === undefined ? u.active : input.active ? 1 : 0, id);
    return this.get(scope, id)!;
  }

  /** Every merchant keeps an active owner and the gateway keeps an active superadmin, so nobody locks themselves out. */
  private assertNotLastTopRole(scope: UserScope, u: UserRow): void {
    const top = scope === "merchant" ? "owner" : "superadmin";
    if (u.role !== top || u.active !== 1) return;
    const others =
      scope === "merchant"
        ? (this.db
            .prepare("SELECT COUNT(*) AS n FROM merchant_users WHERE merchant_id = ? AND role = 'owner' AND active = 1 AND id != ?")
            .get(u.merchant_id!, u.id) as { n: number })
        : (this.db
            .prepare("SELECT COUNT(*) AS n FROM admin_users WHERE role = 'superadmin' AND active = 1 AND id != ?")
            .get(u.id) as { n: number });
    if (others.n === 0) {
      throw new PaymentError(409, "last_owner", scope === "merchant" ? "ต้องมีเจ้าของร้านที่ใช้งานอยู่อย่างน้อย 1 คน" : "ต้องมีผู้ดูแลสูงสุดอย่างน้อย 1 คน");
    }
  }

  async resetPassword(scope: UserScope, id: string): Promise<string> {
    if (!this.get(scope, id)) throw new PaymentError(404, "not_found", "ไม่พบบัญชีผู้ใช้");
    const password = temporaryPassword();
    this.db
      .prepare(`UPDATE ${TABLE[scope]} SET password_hash = ?, must_change_password = 1 WHERE id = ?`)
      .run(await hashPassword(password), id);
    return password;
  }

  async changePassword(scope: UserScope, id: string, current: string, next: string): Promise<void> {
    const u = this.get(scope, id);
    if (!u || !(await verifyPassword(current, u.password_hash))) {
      throw new PaymentError(400, "wrong_password", "รหัสผ่านปัจจุบันไม่ถูกต้อง");
    }
    const problem = passwordProblem(next);
    if (problem) throw new PaymentError(400, "weak_password", problem);
    if (current === next) throw new PaymentError(400, "same_password", "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม");
    this.db
      .prepare(`UPDATE ${TABLE[scope]} SET password_hash = ?, must_change_password = 0 WHERE id = ?`)
      .run(await hashPassword(next), id);
  }

  // ---- two-factor authentication ----

  private require(scope: UserScope, id: string): UserRow {
    const u = this.get(scope, id);
    if (!u) throw new PaymentError(404, "not_found", "ไม่พบบัญชีผู้ใช้");
    return u;
  }

  /** Starts (or restarts) enrolment: stores a fresh secret and returns what the authenticator app needs. */
  async beginTotp(scope: UserScope, id: string, issuer: string): Promise<{ secret: string; uri: string; qr: string }> {
    const u = this.require(scope, id);
    if (u.totp_enabled === 1) throw new PaymentError(409, "already_enabled", "เปิดใช้ 2FA อยู่แล้ว");
    const secret = newTotpSecret();
    this.db.prepare(`UPDATE ${TABLE[scope]} SET totp_secret = ?, totp_last_step = NULL WHERE id = ?`).run(secret, id);
    const uri = otpauthUri(issuer, u.email, secret);
    return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) };
  }

  /** Finishes enrolment with a code from the app; returns one-time recovery codes. */
  confirmTotp(scope: UserScope, id: string, code: string): string[] {
    const u = this.require(scope, id);
    if (u.totp_enabled === 1) throw new PaymentError(409, "already_enabled", "เปิดใช้ 2FA อยู่แล้ว");
    if (!u.totp_secret) throw new PaymentError(400, "not_started", "กรุณาเริ่มตั้งค่า 2FA ใหม่");
    const step = verifyTotp(u.totp_secret, code.trim(), null);
    if (step === null) throw new PaymentError(400, "invalid_code", "รหัสไม่ถูกต้อง ตรวจสอบเวลาในมือถือแล้วลองใหม่");
    const codes = newRecoveryCodes();
    this.db
      .prepare(`UPDATE ${TABLE[scope]} SET totp_enabled = 1, totp_last_step = ?, recovery_codes = ? WHERE id = ?`)
      .run(step, JSON.stringify(codes.map((c) => sha256(normalizeRecoveryCode(c)))), id);
    return codes;
  }

  /**
   * Checks a second factor: a 6-digit app code, or a recovery code (which is then used up).
   * Returns how it was satisfied, or null when the code is wrong.
   */
  verifySecondFactor(scope: UserScope, id: string, code: string): "totp" | "recovery" | null {
    const u = this.require(scope, id);
    if (u.totp_enabled !== 1 || !u.totp_secret) return null;
    const trimmed = code.trim();
    const step = verifyTotp(u.totp_secret, trimmed.replace(/\s/g, ""), u.totp_last_step);
    if (step !== null) {
      // Only move forward, so two concurrent requests with the same code cannot both pass.
      const r = this.db
        .prepare(`UPDATE ${TABLE[scope]} SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`)
        .run(step, id, step);
      return r.changes === 1 ? "totp" : null;
    }
    const hashes: string[] = u.recovery_codes ? JSON.parse(u.recovery_codes) : [];
    const h = sha256(normalizeRecoveryCode(trimmed));
    if (!hashes.includes(h)) return null;
    const left = JSON.stringify(hashes.filter((x) => x !== h));
    const r = this.db
      .prepare(`UPDATE ${TABLE[scope]} SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?`)
      .run(left, id, u.recovery_codes);
    return r.changes === 1 ? "recovery" : null;
  }

  recoveryCodesLeft(scope: UserScope, id: string): number {
    const u = this.require(scope, id);
    return u.recovery_codes ? (JSON.parse(u.recovery_codes) as string[]).length : 0;
  }

  /** Replaces recovery codes after proving possession of the second factor. */
  regenerateRecoveryCodes(scope: UserScope, id: string, code: string): string[] {
    if (!this.verifySecondFactor(scope, id, code)) throw new PaymentError(400, "invalid_code", "รหัสไม่ถูกต้อง");
    const codes = newRecoveryCodes();
    this.db
      .prepare(`UPDATE ${TABLE[scope]} SET recovery_codes = ? WHERE id = ?`)
      .run(JSON.stringify(codes.map((c) => sha256(normalizeRecoveryCode(c)))), id);
    return codes;
  }

  /** Turns 2FA off: by the user (with a code) or by whoever manages accounts (lost phone). */
  disableTotp(scope: UserScope, id: string, code?: string): void {
    this.require(scope, id);
    if (code !== undefined && !this.verifySecondFactor(scope, id, code)) {
      throw new PaymentError(400, "invalid_code", "รหัสไม่ถูกต้อง");
    }
    this.db
      .prepare(`UPDATE ${TABLE[scope]} SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, recovery_codes = NULL WHERE id = ?`)
      .run(id);
  }

  touchLogin(scope: UserScope, id: string): void {
    this.db.prepare(`UPDATE ${TABLE[scope]} SET last_login_at = ? WHERE id = ?`).run(now(), id);
  }
}
