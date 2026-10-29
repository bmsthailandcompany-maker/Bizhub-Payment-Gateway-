import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { hashPassword, passwordProblem, temporaryPassword, verifyPassword } from "../auth/passwords.ts";
import { newId } from "../ids.ts";
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

  touchLogin(scope: UserScope, id: string): void {
    this.db.prepare(`UPDATE ${TABLE[scope]} SET last_login_at = ? WHERE id = ?`).run(now(), id);
  }
}
