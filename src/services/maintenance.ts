import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { putObject, type S3Config } from "./s3.ts";

/**
 * Housekeeping for a self-hosted install: daily database backups and, when the shop sets a
 * retention period, deleting slip images of closed payments (PDPA: keep personal data no longer
 * than needed). The bank's transaction reference stays, so duplicate-slip protection still works.
 */
export class MaintenanceService {
  private lastBackupAt = 0;
  /** Database backups written locally but not yet copied off-site (retried each run). */
  private pendingOffsite = new Set<string>();
  lastOffsiteError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: {
      dataDir: string;
      slipDir: string;
      slipRetentionDays: number;
      backupIntervalHours: number;
      backupKeep: number;
      offsite?: S3Config | null;
      fetchImpl?: typeof fetch;
    },
  ) {
    const newest = this.listBackups()[0];
    if (newest) this.lastBackupAt = fs.statSync(newest).mtimeMs;
  }

  get backupDir(): string {
    return path.join(this.opts.dataDir, "backups");
  }

  listBackups(): string[] {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs
      .readdirSync(this.backupDir)
      .filter((f) => /^gateway-\d{8}-\d{6}\.db$/.test(f))
      .sort()
      .reverse()
      .map((f) => path.join(this.backupDir, f));
  }

  /** Writes a consistent copy of the live database (safe while the server runs) and prunes old copies. */
  backup(): string {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const file = path.join(this.backupDir, `gateway-${stamp}.db`);
    if (fs.existsSync(file)) fs.rmSync(file);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    for (const old of this.listBackups().slice(Math.max(1, this.opts.backupKeep))) fs.rmSync(old);
    this.lastBackupAt = Date.now();
    return file;
  }

  /** Deletes slip images of payments closed more than `days` ago. Returns how many were removed. */
  purgeSlips(days = this.opts.slipRetentionDays): number {
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, slip_path FROM payments WHERE slip_path IS NOT NULL
           AND status IN ('succeeded', 'failed', 'expired', 'cancelled') AND updated_at < ? LIMIT 1000`,
      )
      .all(cutoff) as { id: string; slip_path: string }[];
    for (const r of rows) {
      fs.rmSync(path.join(this.opts.slipDir, path.basename(r.slip_path)), { force: true });
      this.db.prepare("UPDATE payments SET slip_path = NULL, slip_mime = NULL, slip_purged_at = ? WHERE id = ?").run(now(), r.id);
    }
    return rows.length;
  }

  /**
   * Copies new database backups and slip images to S3-compatible storage, so a lost server
   * does not take the only copy with it. Failures are kept and retried on the next run.
   */
  async syncOffsite(limit = 50): Promise<{ uploaded: number }> {
    const cfg = this.opts.offsite;
    if (!cfg) return { uploaded: 0 };
    let uploaded = 0;
    try {
      for (const file of [...this.pendingOffsite]) {
        if (fs.existsSync(file)) {
          await putObject(cfg, `db/${path.basename(file)}`, fs.readFileSync(file), "application/vnd.sqlite3", this.opts.fetchImpl);
          uploaded++;
        }
        this.pendingOffsite.delete(file);
      }
      const slips = this.db
        .prepare("SELECT id, slip_path, slip_mime FROM payments WHERE slip_path IS NOT NULL AND slip_offsite_at IS NULL LIMIT ?")
        .all(limit) as { id: string; slip_path: string; slip_mime: string }[];
      for (const s of slips) {
        const file = path.join(this.opts.slipDir, path.basename(s.slip_path));
        if (fs.existsSync(file)) {
          await putObject(cfg, `slips/${path.basename(s.slip_path)}`, fs.readFileSync(file), s.slip_mime || "application/octet-stream", this.opts.fetchImpl);
          uploaded++;
        }
        this.db.prepare("UPDATE payments SET slip_offsite_at = ? WHERE id = ?").run(now(), s.id);
      }
      this.lastOffsiteError = null;
    } catch (err) {
      this.lastOffsiteError = err instanceof Error ? err.message : String(err);
    }
    return { uploaded };
  }

  /** Called by the background job loop. */
  async run(): Promise<{ backup?: string; purged: number; uploaded: number; offsiteError: string | null }> {
    const due = this.opts.backupIntervalHours > 0 && Date.now() - this.lastBackupAt >= this.opts.backupIntervalHours * 3600_000;
    const backup = due ? this.backup() : undefined;
    if (backup && this.opts.offsite) this.pendingOffsite.add(backup);
    const purged = this.purgeSlips();
    const { uploaded } = await this.syncOffsite();
    return { backup, purged, uploaded, offsiteError: this.lastOffsiteError };
  }
}
