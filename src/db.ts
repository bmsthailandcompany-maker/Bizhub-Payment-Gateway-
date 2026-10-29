import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  promptpay_id TEXT,
  bank_name TEXT,
  bank_account_no TEXT,
  bank_account_name TEXT,
  webhook_url TEXT,
  webhook_secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  livemode INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  reference TEXT,
  description TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  return_url TEXT,
  promptpay_payload TEXT,
  provider_ref TEXT,
  failure_reason TEXT,
  slip_path TEXT,
  slip_mime TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_merchant_idx ON payments(merchant_id, created_at);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status, expires_at);

-- A bank transaction can pay for at most one payment.
CREATE TABLE IF NOT EXISTS used_slips (
  trans_ref TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slip_checks (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  trans_ref TEXT,
  amount INTEGER,
  raw TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS slip_checks_payment_idx ON slip_checks(payment_id, created_at);

-- Staff of a merchant who sign in to the merchant dashboard.
CREATE TABLE IF NOT EXISTS merchant_users (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS merchant_users_merchant_idx ON merchant_users(merchant_id);

-- Gateway operators who sign in to the admin console.
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

-- Browser sessions for both dashboards. Exactly one principal column is set:
-- user_id (staff / admin user), api_key_id (merchant owner via secret key) or neither for ADMIN_TOKEN.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  merchant_id TEXT,
  user_id TEXT,
  api_key_id TEXT,
  livemode INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  merchant_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_merchant_idx ON audit_log(merchant_id, created_at);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at);

-- A merchant's bank account linked for incoming-payment notifications (one per mode).
CREATE TABLE IF NOT EXISTS bank_connections (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  livemode INTEGER NOT NULL,
  label TEXT NOT NULL,
  biller_id TEXT,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_event_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_connections_active_idx ON bank_connections(merchant_id, livemode) WHERE active = 1;

-- Every incoming-money notification, matched or not, so nothing the bank reports is lost.
CREATE TABLE IF NOT EXISTS bank_events (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES bank_connections(id),
  merchant_id TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  trans_ref TEXT NOT NULL,
  amount INTEGER NOT NULL,
  ref1 TEXT,
  ref2 TEXT,
  payer_name TEXT,
  paid_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  payment_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, trans_ref)
);
CREATE INDEX IF NOT EXISTS bank_events_merchant_idx ON bank_events(merchant_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  merchant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, key)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  merchant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_due_idx ON webhook_deliveries(status, next_attempt_at);
`;

export function openDb(dataDir: string | ":memory:"): Db {
  let file = ":memory:";
  if (dataDir !== ":memory:") {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, "gateway.db");
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Columns added after the first release; added in place to databases created before them. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["payments", "slip_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["payments", "verify_status", "TEXT"],
  ["payments", "verify_reason", "TEXT"],
  ["payments", "verify_started_at", "TEXT"],
  ["payments", "verify_retry_at", "TEXT"],
  ["payments", "verify_retries", "INTEGER NOT NULL DEFAULT 0"],
  ["payments", "slip_trans_ref", "TEXT"],
  // Two-factor authentication. totp_secret is set while enrolling; totp_enabled flips once a code is confirmed.
  ["merchant_users", "totp_secret", "TEXT"],
  ["merchant_users", "totp_enabled", "INTEGER NOT NULL DEFAULT 0"],
  ["merchant_users", "totp_last_step", "INTEGER"],
  ["merchant_users", "recovery_codes", "TEXT"],
  ["admin_users", "totp_secret", "TEXT"],
  ["admin_users", "totp_enabled", "INTEGER NOT NULL DEFAULT 0"],
  ["admin_users", "totp_last_step", "INTEGER"],
  ["admin_users", "recovery_codes", "TEXT"],
  ["merchants", "require_2fa", "INTEGER NOT NULL DEFAULT 0"],
  // Short code embedded in bill-payment QRs (Reference 1) and quoted by bank notifications.
  ["payments", "ref_code", "TEXT"],
  // How the money was confirmed: card | slip | bank | manual.
  ["payments", "confirmed_by", "TEXT"],
];

function migrate(db: Db): void {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS payments_verify_retry_idx ON payments(status, verify_retry_at)");
  db.exec("CREATE INDEX IF NOT EXISTS payments_ref_code_idx ON payments(merchant_id, ref_code)");
}

export function now(): string {
  return new Date().toISOString();
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
