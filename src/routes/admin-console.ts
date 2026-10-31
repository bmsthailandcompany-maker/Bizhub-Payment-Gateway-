import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DUMMY_HASH, verifyPassword } from "../auth/passwords.ts";
import { ADMIN_ROLES, type AdminPermission, type AdminRole, MERCHANT_ROLES, type MerchantRole } from "../auth/permissions.ts";
import type { Db } from "../db.ts";
import { now } from "../db.ts";
import { safeEqual } from "../ids.ts";
import type { AuditService } from "../services/audit.ts";
import { type BankService, serializeConnection } from "../services/bank.ts";
import { KYC_DOCUMENT_KINDS, type KycDocumentKind, kycMissing, type KycService } from "../services/kyc.ts";
import { MAX_EXPORT_ROWS, paymentExportTable } from "../services/export.ts";
import type { MerchantService } from "../services/merchants.ts";
import { serializeMerchant } from "../services/merchants.ts";
import type { PaymentService } from "../services/payments.ts";
import { PaymentError } from "../services/payments.ts";
import type { LoginLimiter, SessionService } from "../services/sessions.ts";
import type { SlipService } from "../services/slips.ts";
import { serializeUser, type UserService } from "../services/users.ts";
import { mfaSetupPaths, registerMfaLogin, registerMfaSelfService } from "./mfa.ts";
import { createMerchantSchema, listPaymentsQuery, rejectSchema, updateMerchantSchema } from "./schemas.ts";
import {
  appShell,
  bangkokRange,
  csrfOk,
  exportQuery,
  loginKey,
  pageHeaders,
  readCookie,
  sendExport,
  setSessionCookie,
} from "./web-session.ts";

const COOKIE = "bizhub_admin";
const COOKIE_PATH = "/admin/console";
const BASE = "/admin/console/api";

const loginSchema = z.union([
  z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }),
  z.object({ admin_token: z.string().min(1).max(500) }),
]);
const passwordSchema = z.object({ current_password: z.string().min(1).max(200), new_password: z.string().min(1).max(200) });
const adminRole = z.enum(Object.keys(ADMIN_ROLES) as [AdminRole, ...AdminRole[]]);
const merchantRole = z.enum(Object.keys(MERCHANT_ROLES) as [MerchantRole, ...MerchantRole[]]);
const newUser = <R extends z.ZodTypeAny>(role: R) => z.object({ email: z.string().email().max(200), name: z.string().min(1).max(120), role });
const editUser = <R extends z.ZodTypeAny>(role: R) => z.object({ name: z.string().min(1).max(120), role, active: z.boolean() }).partial();

export interface AdminConsoleDeps {
  db: Db;
  adminToken: string;
  merchants: MerchantService;
  payments: PaymentService;
  slips: SlipService;
  users: UserService;
  sessions: SessionService;
  audit: AuditService;
  limiter: LoginLimiter;
  requireAdmin2fa: boolean;
  bank: BankService;
  kyc: KycService;
}

/**
 * Admin console for gateway operators: a static page plus a cookie-session JSON API.
 * Operators sign in with their own account; ADMIN_TOKEN also works as a superadmin bootstrap.
 */
export async function adminConsoleRoutes(app: FastifyInstance, deps: AdminConsoleDeps) {
  const { db, merchants, payments, slips, users, sessions, audit, limiter } = deps;

  app.get("/admin/console", async (_req, reply) => pageHeaders(reply).send(appShell("Bizhub Admin", "admin.js")));

  app.post(`${BASE}/login`, async (req, reply) => {
    if (!csrfOk(req)) throw new PaymentError(403, "forbidden", "Missing console header");
    const body = loginSchema.parse(req.body);
    const who = "email" in body ? body.email : "admin-token";
    const key = loginKey(req, who);
    if (limiter.blocked(key)) throw new PaymentError(429, "too_many_attempts", "เข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่");

    let token: string | undefined;
    let actorName = who;
    let actorId: string | null = null;
    if ("email" in body) {
      const u = users.findByEmail("admin", body.email);
      const ok = await verifyPassword(body.password, u?.password_hash ?? DUMMY_HASH);
      if (u && ok && u.active === 1 && u.totp_enabled === 1) {
        limiter.succeed(key);
        return { mfa_required: true, mfa_token: sessions.createPending("admin", u.id) };
      }
      if (u && ok && u.active === 1) {
        token = sessions.create({ kind: "admin", userId: u.id });
        users.touchLogin("admin", u.id);
        actorName = u.name;
        actorId = u.id;
      }
    } else if (safeEqual(body.admin_token, deps.adminToken)) {
      token = sessions.create({ kind: "admin" });
      actorName = "ADMIN_TOKEN";
    }

    const actor = { kind: actorId ? "admin_user" : "admin_token", id: actorId, name: actorName, role: "", mustChangePassword: false } as const;
    if (!token) {
      limiter.fail(key);
      audit.log({ merchantId: null, actor: { ...actor, kind: "system" }, action: "admin.login_failed", ip: req.ip });
      throw new PaymentError(401, "unauthorized", "อีเมล รหัสผ่าน หรือ ADMIN_TOKEN ไม่ถูกต้อง");
    }
    limiter.succeed(key);
    audit.log({ merchantId: null, actor, action: "admin.login", ip: req.ip });
    setSessionCookie(req, reply, COOKIE, COOKIE_PATH, token);
    return { ok: true };
  });

  registerMfaLogin(app, {
    base: BASE,
    kind: "admin",
    scope: "admin",
    cookie: { name: COOKIE, path: COOKIE_PATH },
    users,
    sessions,
    audit,
    limiter,
    startSession: (userId) => (users.get("admin", userId)?.active === 1 ? sessions.create({ kind: "admin", userId }) : undefined),
  });

  app.post(`${BASE}/logout`, async (req, reply) => {
    const token = readCookie(req, COOKIE);
    if (token) sessions.end(token);
    setSessionCookie(req, reply, COOKIE, COOKIE_PATH, null);
    return { ok: true };
  });

  await app.register(async (api) => {
    api.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      const token = readCookie(req, COOKIE);
      const auth = token ? sessions.resolveAdmin(token) : undefined;
      if (!auth) return reply.code(401).send({ error: { code: "unauthorized", message: "กรุณาเข้าสู่ระบบ" } });
      if (!csrfOk(req)) return reply.code(403).send({ error: { code: "forbidden", message: "Missing console header" } });
      req.actor = auth.actor;
      req.sessionToken = token;
      req.permissions = ADMIN_ROLES[auth.actor.role as AdminRole]?.permissions ?? [];
      // Order matters: a one-time password is replaced first, then 2FA is set up.
      if (auth.actor.mustChangePassword) {
        if (![`${BASE}/me`, `${BASE}/password`].includes(req.routeOptions.url ?? "")) {
          return reply.code(403).send({ error: { code: "password_change_required", message: "กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน" } });
        }
      } else if (auth.actor.mfaSetupRequired && !mfaSetupPaths(BASE).includes(req.routeOptions.url ?? "")) {
        return reply.code(403).send({ error: { code: "mfa_setup_required", message: "ต้องตั้งค่ายืนยันตัวตน 2 ชั้นก่อนใช้งาน" } });
      }
    });

    const need = (perm: AdminPermission) => async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.permissions!.includes(perm)) {
        return reply.code(403).send({ error: { code: "forbidden", message: "บัญชีของคุณไม่มีสิทธิ์ทำรายการนี้" } });
      }
    };
    const log = (req: FastifyRequest, action: string, merchantId: string | null, target?: string, details?: Record<string, unknown>) =>
      audit.log({ merchantId, actor: req.actor!, action, target, details, ip: req.ip });
    const requireMerchant = (id: string) => {
      const m = merchants.get(id);
      if (!m) throw new PaymentError(404, "not_found", "ไม่พบร้านค้า");
      return m;
    };
    const requirePayment = (id: string) => {
      const p = payments.get(id);
      if (!p) throw new PaymentError(404, "not_found", "ไม่พบรายการ");
      return payments.expireIfDue(p);
    };

    api.get(`${BASE}/me`, async (req) => ({
      user: {
        name: req.actor!.name,
        role: req.actor!.role,
        role_label: ADMIN_ROLES[req.actor!.role as AdminRole]?.label ?? req.actor!.role,
        kind: req.actor!.kind,
        must_change_password: req.actor!.mustChangePassword,
        mfa_setup_required: req.actor!.mfaSetupRequired ?? false,
        two_factor: req.actor!.kind === "admin_user" ? users.get("admin", req.actor!.id!)?.totp_enabled === 1 : null,
      },
      require_admin_2fa: deps.requireAdmin2fa,
      permissions: req.permissions,
      roles: Object.fromEntries(Object.entries(ADMIN_ROLES).map(([k, v]) => [k, { label: v.label, permissions: v.permissions }])),
      merchant_roles: Object.fromEntries(Object.entries(MERCHANT_ROLES).map(([k, v]) => [k, { label: v.label }])),
    }));

    api.post(`${BASE}/password`, async (req) => {
      if (req.actor!.kind !== "admin_user") throw new PaymentError(400, "not_a_user", "เข้าด้วย ADMIN_TOKEN ไม่มีรหัสผ่านให้เปลี่ยน");
      const { current_password, new_password } = passwordSchema.parse(req.body);
      await users.changePassword("admin", req.actor!.id!, current_password, new_password);
      sessions.endForUser(req.actor!.id!, req.sessionToken);
      log(req, "admin_user.password_changed", null, req.actor!.id!);
      return { ok: true };
    });

    // ---- overview ----
    api.get(`${BASE}/summary`, { preHandler: need("payments.view") }, async (req) => {
      const { livemode } = z.object({ livemode: z.enum(["true", "false"]).default("true") }).parse(req.query);
      const live = livemode === "true";
      const since = new Date(Date.now() - 14 * 86400_000).toISOString();
      const top = db
        .prepare(
          `SELECT m.id, m.name, SUM(p.amount) AS amount, COUNT(*) AS count FROM payments p JOIN merchants m ON m.id = p.merchant_id
           WHERE p.status = 'succeeded' AND p.livemode = ? AND p.paid_at >= ? GROUP BY m.id ORDER BY amount DESC LIMIT 5`,
        )
        .all(live ? 1 : 0, since);
      const merchantCounts = db.prepare("SELECT SUM(active) AS active, COUNT(*) AS total FROM merchants").get() as { active: number; total: number };
      const failedWebhooks = (db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'failed'").get() as { n: number }).n;
      return {
        ...payments.summary(null, live),
        livemode: live,
        top_merchants: top,
        merchants: { active: merchantCounts.active ?? 0, total: merchantCounts.total },
        failed_webhooks: failedWebhooks,
        pending_kyc: deps.kyc.pendingCount(),
      };
    });

    // ---- merchants ----
    api.get(`${BASE}/merchants`, { preHandler: need("merchants.view") }, async (req) => {
      const { q, kyc } = z
        .object({ q: z.string().max(100).optional(), kyc: z.enum(["draft", "submitted", "approved", "rejected"]).optional() })
        .parse(req.query);
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const stats = new Map(
        (
          db
            .prepare(
              `SELECT merchant_id,
                 SUM(CASE WHEN status = 'succeeded' AND livemode = 1 AND paid_at >= ? THEN amount ELSE 0 END) AS volume_30d,
                 SUM(CASE WHEN status = 'awaiting_review' THEN 1 ELSE 0 END) AS awaiting_review,
                 MAX(created_at) AS last_payment_at
               FROM payments GROUP BY merchant_id`,
            )
            .all(since) as { merchant_id: string; volume_30d: number; awaiting_review: number; last_payment_at: string }[]
        ).map((r) => [r.merchant_id, r]),
      );
      const userCounts = new Map(
        (db.prepare("SELECT merchant_id, COUNT(*) AS n FROM merchant_users WHERE active = 1 GROUP BY merchant_id").all() as {
          merchant_id: string;
          n: number;
        }[]).map((r) => [r.merchant_id, r.n]),
      );
      const needle = q?.trim().toLowerCase();
      return {
        object: "list",
        data: merchants
          .list()
          .filter((m) => !kyc || m.kyc_status === kyc)
          .filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.id === needle || (m.promptpay_id ?? "").includes(needle))
          .map((m) => ({
            ...serializeMerchant(m),
            volume_30d: stats.get(m.id)?.volume_30d ?? 0,
            awaiting_review: stats.get(m.id)?.awaiting_review ?? 0,
            last_payment_at: stats.get(m.id)?.last_payment_at ?? null,
            staff: userCounts.get(m.id) ?? 0,
          })),
      };
    });

    api.post(`${BASE}/merchants`, { preHandler: need("merchants.manage") }, async (req, reply) => {
      const { merchant, keys } = merchants.create(createMerchantSchema.parse(req.body));
      log(req, "merchant.create", merchant.id, merchant.id, { name: merchant.name });
      return reply.code(201).send({ ...serializeMerchant(merchant), webhook_secret: merchant.webhook_secret, ...keys });
    });

    api.get<{ Params: { id: string } }>(`${BASE}/merchants/:id`, { preHandler: need("merchants.view") }, async (req) => {
      const m = requireMerchant(req.params.id);
      const keys = db
        .prepare("SELECT key_prefix, livemode, created_at FROM api_keys WHERE merchant_id = ? AND revoked_at IS NULL ORDER BY livemode")
        .all(m.id);
      return {
        ...serializeMerchant(m),
        api_keys: keys,
        users: users.list("merchant", m.id).map(serializeUser),
        bank_connections: deps.bank.listForMerchant(m.id).map(serializeConnection),
        kyc_documents: deps.kyc.documents(m.id).map((d) => ({
          id: d.id, kind: d.kind, kind_label: KYC_DOCUMENT_KINDS[d.kind as KycDocumentKind] ?? d.kind, filename: d.filename, mime: d.mime, size: d.size, created_at: d.created_at,
        })),
        kyc_missing: kycMissing(m, deps.kyc.documents(m.id)),
        summary: payments.summary(m.id, true),
      };
    });

    api.patch<{ Params: { id: string } }>(`${BASE}/merchants/:id`, { preHandler: need("merchants.manage") }, async (req) => {
      const before = requireMerchant(req.params.id);
      const input = updateMerchantSchema.parse(req.body);
      const after = merchants.update(before.id, input)!;
      log(req, "merchant.update", after.id, after.id, { changes: input });
      return serializeMerchant(after);
    });

    api.get<{ Params: { id: string; docId: string } }>(`${BASE}/merchants/:id/kyc-documents/:docId`, { preHandler: need("merchants.view") }, async (req, reply) => {
      const { row, data } = deps.kyc.document(requireMerchant(req.params.id).id, req.params.docId);
      log(req, "kyc.document_viewed", req.params.id, row.id, { kind: row.kind });
      return reply.type(row.mime).header("Cache-Control", "private, no-store").send(data);
    });

    api.post<{ Params: { id: string } }>(`${BASE}/merchants/:id/kyc-review`, { preHandler: need("merchants.manage") }, async (req) => {
      const { decision, note } = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() }).parse(req.body);
      const m = deps.kyc.review(requireMerchant(req.params.id), decision, note || null, req.actor!);
      log(req, decision === "approve" ? "kyc.approved" : "kyc.rejected", m.id, m.id, { note });
      return serializeMerchant(m);
    });

    api.post<{ Params: { id: string } }>(`${BASE}/merchants/:id/rotate-keys`, { preHandler: need("merchants.manage") }, async (req) => {
      const m = requireMerchant(req.params.id);
      const keys = merchants.rotateKeys(m.id);
      log(req, "merchant.rotate_keys", m.id, m.id);
      return keys;
    });

    api.post<{ Params: { id: string } }>(`${BASE}/merchants/:id/rotate-webhook-secret`, { preHandler: need("merchants.manage") }, async (req) => {
      const m = requireMerchant(req.params.id);
      const secret = merchants.rotateWebhookSecret(m.id);
      log(req, "merchant.rotate_webhook_secret", m.id, m.id);
      return { webhook_secret: secret };
    });

    // ---- merchant staff (e.g. the first owner account) ----
    const merchantUser = (merchantId: string, id: string) => {
      const u = users.get("merchant", id);
      if (!u || u.merchant_id !== merchantId) throw new PaymentError(404, "not_found", "ไม่พบบัญชีผู้ใช้");
      return u;
    };

    api.get<{ Params: { id: string } }>(`${BASE}/merchants/:id/users`, { preHandler: need("merchants.view") }, async (req) => ({
      object: "list",
      data: users.list("merchant", requireMerchant(req.params.id).id).map(serializeUser),
    }));

    api.post<{ Params: { id: string } }>(`${BASE}/merchants/:id/users`, { preHandler: need("merchant_users.manage") }, async (req, reply) => {
      const m = requireMerchant(req.params.id);
      const input = newUser(merchantRole).parse(req.body);
      const { user, temporaryPassword } = await users.create("merchant", { ...input, merchantId: m.id });
      log(req, "merchant_user.create", m.id, user.id, { email: user.email, role: user.role });
      return reply.code(201).send({ ...serializeUser(user), temporary_password: temporaryPassword });
    });

    api.patch<{ Params: { id: string; userId: string } }>(
      `${BASE}/merchants/:id/users/:userId`,
      { preHandler: need("merchant_users.manage") },
      async (req) => {
        const before = merchantUser(req.params.id, req.params.userId);
        const input = editUser(merchantRole).parse(req.body);
        const after = users.update("merchant", before.id, input);
        if (after.active === 0) sessions.endForUser(after.id);
        log(req, "merchant_user.update", req.params.id, after.id, { email: after.email, changes: input });
        return serializeUser(after);
      },
    );

    api.post<{ Params: { id: string; userId: string } }>(
      `${BASE}/merchants/:id/users/:userId/reset-password`,
      { preHandler: need("merchant_users.manage") },
      async (req) => {
        const u = merchantUser(req.params.id, req.params.userId);
        const password = await users.resetPassword("merchant", u.id);
        sessions.endForUser(u.id);
        log(req, "merchant_user.reset_password", req.params.id, u.id, { email: u.email });
        return { temporary_password: password };
      },
    );

    // ---- payments across all merchants ----
    const paymentsQuery = listPaymentsQuery.extend({
      q: z.string().max(100).optional(),
      livemode: z.enum(["true", "false"]).default("true"),
    });

    api.get(`${BASE}/payments`, { preHandler: need("payments.view") }, async (req) => {
      const q = paymentsQuery.parse(req.query);
      const rows = payments.list(
        { merchantId: q.merchant_id, livemode: q.livemode === "true", status: q.status, search: q.q?.trim() || undefined },
        q.limit + 1,
        q.starting_after,
      );
      const names = new Map(merchants.list().map((m) => [m.id, m.name]));
      return {
        object: "list",
        data: rows.slice(0, q.limit).map((p) => ({ ...payments.serialize(p), merchant_id: p.merchant_id, merchant_name: names.get(p.merchant_id) })),
        has_more: rows.length > q.limit,
      };
    });

    api.get(`${BASE}/payments/export`, { preHandler: need("payments.export") }, async (req, reply) => {
      const q = exportQuery
        .extend({ merchant_id: z.string().max(64).optional(), livemode: z.enum(["true", "false"]).default("true") })
        .parse(req.query);
      const live = q.livemode === "true";
      const rows = payments.exportRows(
        { merchantId: q.merchant_id, livemode: live, status: q.status, search: q.q?.trim() || undefined, ...bangkokRange(q.from, q.to) },
        MAX_EXPORT_ROWS + 1,
      );
      log(req, "payments.export", q.merchant_id ?? null, undefined, { format: q.format, rows: rows.length, merchant_id: q.merchant_id, from: q.from, to: q.to });
      return sendExport(reply, q.format, `gateway-payments-${live ? "live" : "test"}`, paymentExportTable(rows, true));
    });

    api.get<{ Params: { id: string } }>(`${BASE}/payments/:id`, { preHandler: need("payments.view") }, async (req) => {
      const p = requirePayment(req.params.id);
      return {
        ...payments.serialize(p),
        merchant_id: p.merchant_id,
        merchant_name: merchants.get(p.merchant_id)?.name,
        slip_checks: slips.history(p.id),
      };
    });

    api.get<{ Params: { id: string } }>(`${BASE}/payments/:id/slip`, { preHandler: need("payments.view") }, async (req, reply) => {
      const slip = payments.readSlip(requirePayment(req.params.id));
      if (!slip) throw new PaymentError(404, "not_found", "No slip uploaded for this payment");
      return reply.type(slip.mime).header("Cache-Control", "private, no-store").send(slip.data);
    });

    api.post<{ Params: { id: string } }>(`${BASE}/payments/:id/approve`, { preHandler: need("payments.review") }, async (req) => {
      const p = payments.approve(requirePayment(req.params.id));
      log(req, "payment.approve", p.merchant_id, p.id, { amount: p.amount });
      return payments.serialize(p);
    });

    api.post<{ Params: { id: string } }>(`${BASE}/payments/:id/reject`, { preHandler: need("payments.review") }, async (req) => {
      const { reason } = rejectSchema.parse(req.body ?? {});
      const p = payments.reject(requirePayment(req.params.id), reason);
      log(req, "payment.reject", p.merchant_id, p.id, { reason });
      return payments.serialize(p);
    });

    // ---- webhooks ----
    api.get(`${BASE}/webhooks`, { preHandler: need("merchants.view") }, async (req) => {
      const { status } = z.object({ status: z.enum(["pending", "delivered", "failed"]).optional() }).parse(req.query);
      return {
        object: "list",
        data: db
          .prepare(
            `SELECT d.id, d.merchant_id, m.name AS merchant_name, e.type AS event_type, e.payment_id, d.url, d.status, d.attempts,
                    d.last_status_code, d.last_error, d.next_attempt_at, d.created_at
             FROM webhook_deliveries d JOIN events e ON e.id = d.event_id JOIN merchants m ON m.id = d.merchant_id
             ${status ? "WHERE d.status = ?" : ""} ORDER BY d.created_at DESC LIMIT 100`,
          )
          .all(...(status ? [status] : [])),
      };
    });

    api.post<{ Params: { id: string } }>(`${BASE}/webhooks/:id/retry`, { preHandler: need("webhooks.manage") }, async (req) => {
      const d = db.prepare("SELECT merchant_id FROM webhook_deliveries WHERE id = ?").get(req.params.id) as { merchant_id: string } | undefined;
      if (!d) throw new PaymentError(404, "not_found", "ไม่พบรายการส่ง webhook");
      db.prepare("UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), req.params.id);
      log(req, "webhook.retry", d.merchant_id, req.params.id);
      return { id: req.params.id, status: "pending" };
    });

    // ---- admin accounts ----
    api.get(`${BASE}/admins`, { preHandler: need("admins.manage") }, async () => ({
      object: "list",
      data: users.list("admin").map(serializeUser),
    }));

    api.post(`${BASE}/admins`, { preHandler: need("admins.manage") }, async (req, reply) => {
      const input = newUser(adminRole).parse(req.body);
      const { user, temporaryPassword } = await users.create("admin", input);
      log(req, "admin_user.create", null, user.id, { email: user.email, role: user.role });
      return reply.code(201).send({ ...serializeUser(user), temporary_password: temporaryPassword });
    });

    api.patch<{ Params: { id: string } }>(`${BASE}/admins/:id`, { preHandler: need("admins.manage") }, async (req) => {
      const input = editUser(adminRole).parse(req.body);
      const after = users.update("admin", req.params.id, input);
      if (after.active === 0) sessions.endForUser(after.id);
      log(req, "admin_user.update", null, after.id, { email: after.email, changes: input });
      return serializeUser(after);
    });

    api.post<{ Params: { id: string } }>(`${BASE}/admins/:id/reset-password`, { preHandler: need("admins.manage") }, async (req) => {
      const password = await users.resetPassword("admin", req.params.id);
      sessions.endForUser(req.params.id);
      log(req, "admin_user.reset_password", null, req.params.id);
      return { temporary_password: password };
    });

    registerMfaSelfService(api, {
      base: BASE,
      scope: "admin",
      issuer: () => "Bizhub Admin",
      users,
      sessions,
      required: () => deps.requireAdmin2fa,
      log: (req, action, target, details) => log(req, action, null, target, details),
    });

    api.post<{ Params: { id: string } }>(`${BASE}/admins/:id/reset-2fa`, { preHandler: need("admins.manage") }, async (req) => {
      if (!users.get("admin", req.params.id)) throw new PaymentError(404, "not_found", "ไม่พบบัญชีผู้ใช้");
      users.disableTotp("admin", req.params.id);
      sessions.endForUser(req.params.id);
      log(req, "admin_user.2fa_reset", null, req.params.id);
      return { ok: true };
    });

    api.post<{ Params: { id: string; userId: string } }>(
      `${BASE}/merchants/:id/users/:userId/reset-2fa`,
      { preHandler: need("merchant_users.manage") },
      async (req) => {
        const u = merchantUser(req.params.id, req.params.userId);
        users.disableTotp("merchant", u.id);
        sessions.endForUser(u.id);
        log(req, "merchant_user.2fa_reset", req.params.id, u.id, { email: u.email });
        return { ok: true };
      },
    );

    api.get(`${BASE}/audit`, { preHandler: need("audit.view") }, async (req) => {
      const q = z.object({ merchant_id: z.string().max(64).optional(), before: z.string().max(40).optional() }).parse(req.query);
      return { object: "list", data: audit.list({ merchantId: q.merchant_id, before: q.before }, 50) };
    });
  });
}
