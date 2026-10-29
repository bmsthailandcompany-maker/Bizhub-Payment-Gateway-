import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { randomToken, sha256 } from "../ids.ts";
import type { MerchantRow } from "./merchants.ts";

export type SessionKind = "merchant" | "admin";

/** Who did something, carried into permission checks and the audit log. */
export interface Actor {
  kind: "merchant_user" | "api_key" | "admin_user" | "admin_token" | "system";
  id: string | null;
  name: string;
  role: string;
  mustChangePassword: boolean;
}

export const SESSION_TTL_MS = 12 * 3600_000;

interface SessionRow {
  token_hash: string;
  kind: SessionKind;
  merchant_id: string | null;
  user_id: string | null;
  api_key_id: string | null;
  livemode: number;
}

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly adminToken: string,
  ) {}

  create(input: { kind: SessionKind; merchantId?: string; userId?: string; apiKeyId?: string; livemode?: boolean }): string {
    const token = randomToken(48);
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, kind, merchant_id, user_id, api_key_id, livemode, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(token),
        input.kind,
        input.merchantId ?? null,
        input.userId ?? null,
        // ADMIN_TOKEN sessions remember which token minted them, so changing the env var signs them out.
        input.kind === "admin" && !input.userId ? sha256(this.adminToken) : (input.apiKeyId ?? null),
        input.livemode ? 1 : 0,
        new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        now(),
      );
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
    return token;
  }

  private row(token: string, kind: SessionKind): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > ?")
      .get(sha256(token), kind, now()) as SessionRow | undefined;
  }

  /** Resolves a merchant-dashboard session; it dies with its user, its API key or the merchant. */
  resolveMerchant(token: string): { merchant: MerchantRow; livemode: boolean; actor: Actor } | undefined {
    const s = this.row(token, "merchant");
    if (!s?.merchant_id) return undefined;
    const merchant = this.db.prepare("SELECT * FROM merchants WHERE id = ? AND active = 1").get(s.merchant_id) as
      | MerchantRow
      | undefined;
    if (!merchant) return undefined;
    let actor: Actor;
    if (s.user_id) {
      const u = this.db
        .prepare("SELECT id, name, role, must_change_password FROM merchant_users WHERE id = ? AND merchant_id = ? AND active = 1")
        .get(s.user_id, s.merchant_id) as { id: string; name: string; role: string; must_change_password: number } | undefined;
      if (!u) return undefined;
      actor = { kind: "merchant_user", id: u.id, name: u.name, role: u.role, mustChangePassword: u.must_change_password === 1 };
    } else if (s.api_key_id) {
      const k = this.db.prepare("SELECT key_prefix FROM api_keys WHERE id = ? AND revoked_at IS NULL").get(s.api_key_id) as
        | { key_prefix: string }
        | undefined;
      if (!k) return undefined;
      actor = { kind: "api_key", id: s.api_key_id, name: `Secret key ${k.key_prefix}…`, role: "owner", mustChangePassword: false };
    } else {
      return undefined;
    }
    return { merchant, livemode: s.livemode === 1, actor };
  }

  resolveAdmin(token: string): { actor: Actor } | undefined {
    const s = this.row(token, "admin");
    if (!s) return undefined;
    if (s.user_id) {
      const u = this.db
        .prepare("SELECT id, name, role, must_change_password FROM admin_users WHERE id = ? AND active = 1")
        .get(s.user_id) as { id: string; name: string; role: string; must_change_password: number } | undefined;
      if (!u) return undefined;
      return { actor: { kind: "admin_user", id: u.id, name: u.name, role: u.role, mustChangePassword: u.must_change_password === 1 } };
    }
    if (s.api_key_id !== sha256(this.adminToken)) return undefined;
    return { actor: { kind: "admin_token", id: null, name: "ADMIN_TOKEN", role: "superadmin", mustChangePassword: false } };
  }

  setLivemode(token: string, livemode: boolean): void {
    this.db.prepare("UPDATE sessions SET livemode = ? WHERE token_hash = ?").run(livemode ? 1 : 0, sha256(token));
  }

  end(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  /** Signs a user out everywhere (password reset, deactivation), optionally keeping the current session. */
  endForUser(userId: string, exceptToken?: string): void {
    this.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
      .run(userId, exceptToken ? sha256(exceptToken) : "");
  }
}

/** Slows down password guessing: 5 failures per email+IP within 15 minutes locks that pair out for the window. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  private recent(key: string): number[] {
    const cutoff = Date.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  fail(key: string): void {
    this.failures.set(key, [...this.recent(key), Date.now()]);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}
