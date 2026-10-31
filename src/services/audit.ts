import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { newId } from "../ids.ts";
import type { Actor } from "./sessions.ts";

export interface AuditEntry {
  merchantId: string | null;
  actor: Actor;
  action: string;
  target?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

export class AuditService {
  constructor(private readonly db: Db) {}

  log(e: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (id, merchant_id, actor_kind, actor_id, actor_name, action, target, details, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("aud"),
        e.merchantId,
        e.actor.kind,
        e.actor.id,
        e.actor.name,
        e.action,
        e.target ?? null,
        e.details ? JSON.stringify(e.details) : null,
        e.ip ?? null,
        now(),
      );
  }

  list(filter: { merchantId?: string | null; before?: string }, limit = 50) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.merchantId) (where.push("a.merchant_id = ?"), args.push(filter.merchantId));
    if (filter.before) (where.push("a.created_at < ?"), args.push(filter.before));
    const rows = this.db
      .prepare(
        `SELECT a.*, m.name AS merchant_name FROM audit_log a LEFT JOIN merchants m ON m.id = a.merchant_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.created_at DESC LIMIT ?`,
      )
      .all(...args, limit) as Record<string, any>[];
    return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }
}
