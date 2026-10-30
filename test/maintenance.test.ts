import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { MaintenanceService } from "../src/services/maintenance.ts";

function setup(opts: Partial<{ slipRetentionDays: number; backupIntervalHours: number; backupKeep: number }> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bizhub-maint-"));
  const db = openDb(dir);
  const slipDir = path.join(dir, "slips");
  fs.mkdirSync(slipDir);
  db.prepare("INSERT INTO merchants (id, name, webhook_secret, created_at) VALUES ('m', 'Shop', 's', ?)").run(new Date().toISOString());
  const svc = new MaintenanceService(db, { dataDir: dir, slipDir, slipRetentionDays: 0, backupIntervalHours: 24, backupKeep: 3, ...opts });
  const add = (id: string, status: string, daysAgo: number) => {
    const t = new Date(Date.now() - daysAgo * 86400_000).toISOString();
    fs.writeFileSync(path.join(slipDir, `${id}.png`), "x");
    db.prepare(
      `INSERT INTO payments (id, merchant_id, livemode, amount, currency, method, status, slip_path, slip_mime, slip_trans_ref, expires_at, created_at, updated_at)
       VALUES (?, 'm', 1, 100, 'THB', 'bank_transfer', ?, ?, 'image/png', ?, ?, ?, ?)`,
    ).run(id, status, `${id}.png`, "TX" + id, t, t, t);
  };
  return { dir, db, slipDir, svc, add, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("backups are consistent copies, run when due, and old ones are pruned", () => {
  const { dir, svc, add, done } = setup();
  add("p1", "succeeded", 1);
  const first = svc.run().backup!;
  assert.ok(first && fs.existsSync(first));
  const copy = new DatabaseSync(first);
  assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM payments").get() as { n: number }).n, 1);
  copy.close();
  assert.equal(svc.run().backup, undefined, "not due again within the interval");
  for (let i = 0; i < 4; i++) {
    const f = path.join(dir, "backups", `gateway-2020010${i}-000000.db`);
    fs.writeFileSync(f, "old");
  }
  svc.backup();
  assert.equal(svc.listBackups().length, 3, "keeps only the newest backupKeep files");
  done();
});

test("retention deletes slip images of old closed payments only, keeping the bank reference", () => {
  const { db, slipDir, svc, add, done } = setup({ slipRetentionDays: 90, backupIntervalHours: 0 });
  add("old_paid", "succeeded", 120);
  add("old_open", "awaiting_review", 120);
  add("new_paid", "succeeded", 10);
  assert.deepEqual(svc.run(), { backup: undefined, purged: 1 });
  assert.ok(!fs.existsSync(path.join(slipDir, "old_paid.png")));
  assert.ok(fs.existsSync(path.join(slipDir, "old_open.png")), "a slip still waiting for review is kept");
  assert.ok(fs.existsSync(path.join(slipDir, "new_paid.png")));
  const row = db.prepare("SELECT slip_path, slip_trans_ref, slip_purged_at FROM payments WHERE id = 'old_paid'").get() as Record<string, string | null>;
  assert.equal(row.slip_path, null);
  assert.equal(row.slip_trans_ref, "TXold_paid");
  assert.ok(row.slip_purged_at);
  done();
});
