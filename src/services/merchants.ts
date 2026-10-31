import type { Db } from "../db.ts";
import { now, tx } from "../db.ts";
import { newId, randomToken, sha256 } from "../ids.ts";

export interface MerchantRow {
  id: string;
  name: string;
  promptpay_id: string | null;
  bank_name: string | null;
  bank_account_no: string | null;
  bank_account_name: string | null;
  webhook_url: string | null;
  privacy_url: string | null;
  webhook_secret: string;
  active: number;
  require_2fa: number;
  notice_enabled: number;
  created_at: string;
}

export interface MerchantInput {
  name: string;
  promptpay_id?: string | null;
  bank_name?: string | null;
  bank_account_no?: string | null;
  bank_account_name?: string | null;
  webhook_url?: string | null;
  privacy_url?: string | null;
}

export interface IssuedKeys {
  test_secret_key: string;
  live_secret_key: string;
}

export function serializeMerchant(m: MerchantRow) {
  return {
    id: m.id,
    object: "merchant",
    name: m.name,
    promptpay_id: m.promptpay_id,
    bank_account: m.bank_account_no
      ? { bank_name: m.bank_name, account_no: m.bank_account_no, account_name: m.bank_account_name }
      : null,
    webhook_url: m.webhook_url,
    privacy_url: m.privacy_url,
    active: m.active === 1,
    require_2fa: m.require_2fa === 1,
    notice_enabled: m.notice_enabled === 1,
    created_at: m.created_at,
  };
}

export class MerchantService {
  constructor(private readonly db: Db) {}

  get(id: string): MerchantRow | undefined {
    return this.db.prepare("SELECT * FROM merchants WHERE id = ?").get(id) as MerchantRow | undefined;
  }

  list(): MerchantRow[] {
    return this.db.prepare("SELECT * FROM merchants ORDER BY created_at DESC").all() as unknown as MerchantRow[];
  }

  create(input: MerchantInput): { merchant: MerchantRow; keys: IssuedKeys } {
    return tx(this.db, () => {
      const id = newId("mch");
      this.db
        .prepare(
          `INSERT INTO merchants (id, name, promptpay_id, bank_name, bank_account_no, bank_account_name, webhook_url, webhook_secret, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.promptpay_id ?? null,
          input.bank_name ?? null,
          input.bank_account_no ?? null,
          input.bank_account_name ?? null,
          input.webhook_url ?? null,
          "whsec_" + randomToken(32),
          now(),
        );
      const keys = this.issueKeys(id);
      return { merchant: this.get(id)!, keys };
    });
  }

  update(
    id: string,
    input: Partial<MerchantInput> & { active?: boolean; require_2fa?: boolean; notice_enabled?: boolean },
  ): MerchantRow | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = {
      ...current,
      ...input,
      active: input.active === undefined ? current.active : input.active ? 1 : 0,
      require_2fa: input.require_2fa === undefined ? current.require_2fa : input.require_2fa ? 1 : 0,
      notice_enabled: input.notice_enabled === undefined ? current.notice_enabled : input.notice_enabled ? 1 : 0,
    };
    this.db
      .prepare(
        `UPDATE merchants SET name=?, promptpay_id=?, bank_name=?, bank_account_no=?, bank_account_name=?, webhook_url=?, privacy_url=?, active=?, require_2fa=?, notice_enabled=? WHERE id=?`,
      )
      .run(
        next.name,
        next.promptpay_id ?? null,
        next.bank_name ?? null,
        next.bank_account_no ?? null,
        next.bank_account_name ?? null,
        next.webhook_url ?? null,
        next.privacy_url ?? null,
        next.active,
        next.require_2fa,
        next.notice_enabled,
        id,
      );
    return this.get(id);
  }

  /** Revokes all existing API keys for the merchant and issues a fresh test/live pair. */
  rotateKeys(id: string): IssuedKeys {
    return tx(this.db, () => {
      this.db.prepare("UPDATE api_keys SET revoked_at=? WHERE merchant_id=? AND revoked_at IS NULL").run(now(), id);
      return this.issueKeys(id);
    });
  }

  rotateWebhookSecret(id: string): string {
    const secret = "whsec_" + randomToken(32);
    this.db.prepare("UPDATE merchants SET webhook_secret=? WHERE id=?").run(secret, id);
    return secret;
  }

  private issueKeys(merchantId: string): IssuedKeys {
    const insert = this.db.prepare(
      "INSERT INTO api_keys (id, merchant_id, key_hash, key_prefix, livemode, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const make = (live: boolean) => {
      const key = `sk_${live ? "live" : "test"}_${randomToken(32)}`;
      insert.run(newId("key"), merchantId, sha256(key), key.slice(0, 12), live ? 1 : 0, now());
      return key;
    };
    return { test_secret_key: make(false), live_secret_key: make(true) };
  }

  /** Resolves a secret key to its merchant; returns undefined for unknown, revoked or inactive. */
  authenticate(secretKey: string): { merchant: MerchantRow; livemode: boolean; keyId: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT k.livemode, k.id AS key_id, m.* FROM api_keys k JOIN merchants m ON m.id = k.merchant_id
         WHERE k.key_hash = ? AND k.revoked_at IS NULL AND m.active = 1`,
      )
      .get(sha256(secretKey)) as (MerchantRow & { livemode: number; key_id: string }) | undefined;
    if (!row) return undefined;
    const { livemode, key_id, ...merchant } = row;
    return { merchant, livemode: livemode === 1, keyId: key_id };
  }
}
