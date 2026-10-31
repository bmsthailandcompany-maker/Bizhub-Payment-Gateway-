import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DUMMY_HASH, verifyPassword } from "../auth/passwords.ts";
import { MERCHANT_ROLES, type MerchantPermission, type MerchantRole } from "../auth/permissions.ts";
import type { Db } from "../db.ts";
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
import { isValidBillerId } from "../promptpay.ts";
import { looksLike } from "./checkout.ts";
import { createPaymentSchema, listPaymentsQuery, rejectSchema } from "./schemas.ts";
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

export const COOKIE = "bizhub_session";
export const COOKIE_PATH = "/dashboard";

const loginSchema = z.union([
  z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }),
  z.object({ secret_key: z.string().min(1).max(200) }),
]);
const passwordSchema = z.object({ current_password: z.string().min(1).max(200), new_password: z.string().min(1).max(200) });
const roleSchema = z.enum(Object.keys(MERCHANT_ROLES) as [MerchantRole, ...MerchantRole[]]);
const createUserSchema = z.object({ email: z.string().email().max(200), name: z.string().min(1).max(120), role: roleSchema });
const updateUserSchema = z.object({ name: z.string().min(1).max(120), role: roleSchema, active: z.boolean() }).partial();

export interface DashboardDeps {
  db: Db;
  merchants: MerchantService;
  payments: PaymentService;
  slips: SlipService;
  users: UserService;
  sessions: SessionService;
  audit: AuditService;
  limiter: LoginLimiter;
  bank: BankService;
  kyc: KycService;
  publicBaseUrl: string;
}

/**
 * Merchant dashboard: a static page plus a cookie-session JSON API under /dashboard/api.
 * Staff sign in with email + password and get their role's permissions; the merchant's
 * secret key also works and acts as the owner.
 */
export async function dashboardRoutes(app: FastifyInstance, deps: DashboardDeps) {
  const { db, merchants, payments, slips, users, sessions, audit, limiter, bank, kyc } = deps;

  app.get("/dashboard", async (_req, reply) => pageHeaders(reply).send(appShell("Bizhub Dashboard", "dashboard.js")));

  app.post("/dashboard/api/login", async (req, reply) => {
    if (!csrfOk(req)) throw new PaymentError(403, "forbidden", "Missing dashboard header");
    const body = loginSchema.parse(req.body);
    const who = "email" in body ? body.email : "secret-key";
    const key = loginKey(req, who);
    if (limiter.blocked(key)) {
      throw new PaymentError(429, "too_many_attempts", "เข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่");
    }

    let token: string | undefined;
    let merchantId: string | undefined;
    let actorName = who;
    let actorId: string | null = null;
    if ("email" in body) {
      const u = users.findByEmail("merchant", body.email);
      // Always run the hash so response time does not reveal whether the email exists.
      const ok = await verifyPassword(body.password, u?.password_hash ?? DUMMY_HASH);
      const merchant = u ? merchants.get(u.merchant_id!) : undefined;
      if (u && ok && u.active === 1 && merchant?.active === 1 && u.totp_enabled === 1) {
        // Password is right; the session is only issued after the 2FA code (see /login/2fa).
        limiter.succeed(key);
        return { mfa_required: true, mfa_token: sessions.createPending("merchant", u.id, u.merchant_id!) };
      }
      if (u && ok && u.active === 1 && merchant?.active === 1) {
        token = sessions.create({ kind: "merchant", merchantId: u.merchant_id!, userId: u.id, livemode: true });
        users.touchLogin("merchant", u.id);
        merchantId = u.merchant_id!;
        actorName = u.name;
        actorId = u.id;
      } else if (u) {
        merchantId = u.merchant_id!;
      }
    } else {
      const auth = merchants.authenticate(body.secret_key.trim());
      if (auth && auth.livemode && auth.merchant.kyc_status !== "approved") {
        throw new PaymentError(403, "account_not_approved", "ร้านยังไม่ผ่านการตรวจเอกสาร ใช้ Secret key โหมดทดสอบ (sk_test_) ไปก่อน");
      }
      if (auth) {
        token = sessions.create({ kind: "merchant", merchantId: auth.merchant.id, apiKeyId: auth.keyId, livemode: auth.livemode });
        merchantId = auth.merchant.id;
        actorName = `Secret key ${body.secret_key.trim().slice(0, 12)}…`;
        actorId = auth.keyId;
      }
    }

    if (!token) {
      limiter.fail(key);
      if (merchantId) {
        audit.log({ merchantId, actor: { kind: "system", id: null, name: who, role: "", mustChangePassword: false }, action: "auth.login_failed", ip: req.ip });
      }
      throw new PaymentError(401, "unauthorized", "อีเมล รหัสผ่าน หรือ Secret key ไม่ถูกต้อง");
    }
    limiter.succeed(key);
    audit.log({
      merchantId: merchantId!,
      actor: { kind: actorId?.startsWith("key_") ? "api_key" : "merchant_user", id: actorId, name: actorName, role: "", mustChangePassword: false },
      action: "auth.login",
      ip: req.ip,
    });
    setSessionCookie(req, reply, COOKIE, COOKIE_PATH, token);
    return { ok: true };
  });

  registerMfaLogin(app, {
    base: "/dashboard/api",
    kind: "merchant",
    scope: "merchant",
    cookie: { name: COOKIE, path: COOKIE_PATH },
    users,
    sessions,
    audit,
    limiter,
    startSession: (userId, merchantId) => {
      const u = users.get("merchant", userId);
      const m = merchantId ? merchants.get(merchantId) : undefined;
      if (!u || u.active !== 1 || m?.active !== 1) return undefined;
      return sessions.create({ kind: "merchant", merchantId: m.id, userId: u.id, livemode: true });
    },
  });

  app.post("/dashboard/api/logout", async (req, reply) => {
    const token = readCookie(req, COOKIE);
    if (token) sessions.end(token);
    setSessionCookie(req, reply, COOKIE, COOKIE_PATH, null);
    return { ok: true };
  });

  await app.register(async (api) => {
    api.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      const token = readCookie(req, COOKIE);
      const auth = token ? sessions.resolveMerchant(token) : undefined;
      if (!auth) return reply.code(401).send({ error: { code: "unauthorized", message: "กรุณาเข้าสู่ระบบ" } });
      if (!csrfOk(req)) return reply.code(403).send({ error: { code: "forbidden", message: "Missing dashboard header" } });
      req.merchant = auth.merchant;
      req.livemode = auth.livemode;
      req.actor = auth.actor;
      req.sessionToken = token;
      req.permissions = MERCHANT_ROLES[auth.actor.role as MerchantRole]?.permissions ?? [];
      // A one-time password only lets the user set a real one.
      const allowed = ["/dashboard/api/me", "/dashboard/api/password"];
      if (auth.actor.mustChangePassword) {
        if (!allowed.includes(req.routeOptions.url ?? "")) {
          return reply.code(403).send({ error: { code: "password_change_required", message: "กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน" } });
        }
      } else if (auth.actor.mfaSetupRequired && !mfaSetupPaths("/dashboard/api").includes(req.routeOptions.url ?? "")) {
        return reply.code(403).send({ error: { code: "mfa_setup_required", message: "ร้านนี้กำหนดให้ใช้ยืนยันตัวตน 2 ชั้น กรุณาตั้งค่าก่อนใช้งาน" } });
      }
    });

    const need = (perm: MerchantPermission) => async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.permissions!.includes(perm)) {
        return reply.code(403).send({ error: { code: "forbidden", message: "บัญชีของคุณไม่มีสิทธิ์ทำรายการนี้" } });
      }
    };
    const log = (req: FastifyRequest, action: string, target?: string, details?: Record<string, unknown>) =>
      audit.log({ merchantId: req.merchant!.id, actor: req.actor!, action, target, details, ip: req.ip });
    const own = (req: FastifyRequest, id: string) =>
      payments.expireIfDue(payments.getForMerchant(id, req.merchant!.id, req.livemode!));

    api.get("/dashboard/api/me", async (req) => ({
      merchant: serializeMerchant(req.merchant!),
      livemode: req.livemode,
      user: {
        name: req.actor!.name,
        role: req.actor!.role,
        role_label: MERCHANT_ROLES[req.actor!.role as MerchantRole]?.label ?? req.actor!.role,
        kind: req.actor!.kind,
        must_change_password: req.actor!.mustChangePassword,
        mfa_setup_required: req.actor!.mfaSetupRequired ?? false,
        two_factor: req.actor!.kind === "merchant_user" ? users.get("merchant", req.actor!.id!)?.totp_enabled === 1 : null,
      },
      permissions: req.permissions,
      roles: Object.fromEntries(Object.entries(MERCHANT_ROLES).map(([k, v]) => [k, { label: v.label, permissions: v.permissions }])),
      webhook_secret: req.permissions!.includes("webhooks.secret") ? req.merchant!.webhook_secret : null,
    }));

    api.post("/dashboard/api/password", async (req) => {
      if (req.actor!.kind !== "merchant_user") throw new PaymentError(400, "not_a_user", "เข้าด้วย Secret key ไม่มีรหัสผ่านให้เปลี่ยน");
      const { current_password, new_password } = passwordSchema.parse(req.body);
      await users.changePassword("merchant", req.actor!.id!, current_password, new_password);
      sessions.endForUser(req.actor!.id!, req.sessionToken);
      log(req, "user.password_changed", req.actor!.id!);
      return { ok: true };
    });

    // Staff switch between live and test data inside one session; a secret key is bound to its own mode.
    api.post("/dashboard/api/mode", async (req) => {
      const { livemode } = z.object({ livemode: z.boolean() }).parse(req.body);
      if (livemode && req.merchant!.kyc_status !== "approved") {
        throw new PaymentError(403, "account_not_approved", "โหมดใช้งานจริงจะเปิดหลังร้านผ่านการตรวจเอกสาร");
      }
      if (req.actor!.kind === "api_key" && livemode !== req.livemode) {
        throw new PaymentError(400, "key_mode_fixed", "เข้าด้วย Secret key สลับโหมดไม่ได้ กรุณาใช้ key ของโหมดนั้น");
      }
      sessions.setLivemode(req.sessionToken!, livemode);
      return { livemode };
    });

    api.get("/dashboard/api/summary", { preHandler: need("payments.view") }, async (req) =>
      payments.summary(req.merchant!.id, req.livemode!),
    );

    api.get("/dashboard/api/payments", { preHandler: need("payments.view") }, async (req) => {
      const q = listPaymentsQuery.extend({ q: z.string().max(100).optional() }).parse(req.query);
      const rows = payments.list(
        { merchantId: req.merchant!.id, livemode: req.livemode!, status: q.status, search: q.q?.trim() || undefined },
        q.limit + 1,
        q.starting_after,
      );
      return { object: "list", data: rows.slice(0, q.limit).map((p) => payments.serialize(p)), has_more: rows.length > q.limit };
    });

    api.get("/dashboard/api/payments/export", { preHandler: need("payments.export") }, async (req, reply) => {
      const q = exportQuery.parse(req.query);
      const rows = payments.exportRows(
        { merchantId: req.merchant!.id, livemode: req.livemode!, status: q.status, search: q.q?.trim() || undefined, ...bangkokRange(q.from, q.to) },
        MAX_EXPORT_ROWS + 1,
      );
      log(req, "payments.export", undefined, { format: q.format, rows: rows.length, status: q.status, from: q.from, to: q.to });
      return sendExport(reply, q.format, `payments-${req.livemode ? "live" : "test"}`, paymentExportTable(rows, false));
    });

    api.post("/dashboard/api/payments", { preHandler: need("payments.create") }, async (req, reply) => {
      const p = payments.create(req.merchant!, req.livemode!, createPaymentSchema.parse(req.body));
      log(req, "payment.create", p.id, { amount: p.amount, method: p.method });
      return reply.code(201).send(payments.serialize(p));
    });

    api.get<{ Params: { id: string } }>("/dashboard/api/payments/:id", { preHandler: need("payments.view") }, async (req) => {
      const p = own(req, req.params.id);
      return { ...payments.serialize(p), slip_checks: slips.history(p.id) };
    });

    api.get<{ Params: { id: string } }>("/dashboard/api/payments/:id/slip", { preHandler: need("payments.view") }, async (req, reply) => {
      const slip = payments.readSlip(own(req, req.params.id));
      if (!slip) throw new PaymentError(404, "not_found", "No slip uploaded for this payment");
      return reply.type(slip.mime).header("Cache-Control", "private, no-store").send(slip.data);
    });

    api.post<{ Params: { id: string } }>("/dashboard/api/payments/:id/approve", { preHandler: need("payments.review") }, async (req) => {
      const p = payments.approve(own(req, req.params.id));
      log(req, "payment.approve", p.id, { amount: p.amount });
      return payments.serialize(p);
    });

    api.post<{ Params: { id: string } }>("/dashboard/api/payments/:id/reject", { preHandler: need("payments.review") }, async (req) => {
      const { reason } = rejectSchema.parse(req.body ?? {});
      const p = payments.reject(own(req, req.params.id), reason);
      log(req, "payment.reject", p.id, { reason });
      return payments.serialize(p);
    });

    api.post<{ Params: { id: string } }>("/dashboard/api/payments/:id/cancel", { preHandler: need("payments.cancel") }, async (req) => {
      const p = payments.transition(own(req, req.params.id).id, "cancelled");
      log(req, "payment.cancel", p.id);
      return payments.serialize(p);
    });

    api.get("/dashboard/api/webhooks", { preHandler: need("settings.view") }, async (req) => ({
      object: "list",
      data: db
        .prepare(
          `SELECT d.id, e.type AS event_type, e.payment_id, d.url, d.status, d.attempts, d.last_status_code,
                  d.last_error, d.next_attempt_at, d.created_at
           FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
           JOIN payments p ON p.id = e.payment_id
           WHERE d.merchant_id = ? AND p.livemode = ? ORDER BY d.created_at DESC LIMIT 50`,
        )
        .all(req.merchant!.id, req.livemode! ? 1 : 0),
    }));

    // ---- staff accounts ----
    const ownUser = (req: FastifyRequest, id: string) => {
      const u = users.get("merchant", id);
      if (!u || u.merchant_id !== req.merchant!.id) throw new PaymentError(404, "not_found", "ไม่พบบัญชีผู้ใช้");
      return u;
    };

    api.get("/dashboard/api/users", { preHandler: need("users.manage") }, async (req) => ({
      object: "list",
      data: users.list("merchant", req.merchant!.id).map(serializeUser),
    }));

    api.post("/dashboard/api/users", { preHandler: need("users.manage") }, async (req, reply) => {
      const input = createUserSchema.parse(req.body);
      const { user, temporaryPassword } = await users.create("merchant", { ...input, merchantId: req.merchant!.id });
      log(req, "user.create", user.id, { email: user.email, role: user.role });
      return reply.code(201).send({ ...serializeUser(user), temporary_password: temporaryPassword });
    });

    api.patch<{ Params: { id: string } }>("/dashboard/api/users/:id", { preHandler: need("users.manage") }, async (req) => {
      const before = ownUser(req, req.params.id);
      const input = updateUserSchema.parse(req.body);
      const after = users.update("merchant", before.id, input);
      if (after.active === 0) sessions.endForUser(after.id);
      log(req, "user.update", after.id, { email: after.email, from: { role: before.role, active: before.active === 1 }, to: input });
      return serializeUser(after);
    });

    api.post<{ Params: { id: string } }>("/dashboard/api/users/:id/reset-password", { preHandler: need("users.manage") }, async (req) => {
      const u = ownUser(req, req.params.id);
      const password = await users.resetPassword("merchant", u.id);
      sessions.endForUser(u.id);
      log(req, "user.reset_password", u.id, { email: u.email });
      return { temporary_password: password };
    });

    registerMfaSelfService(api, {
      base: "/dashboard/api",
      scope: "merchant",
      issuer: (req) => `Bizhub (${req.merchant!.name})`,
      users,
      sessions,
      required: (req) => req.merchant!.require_2fa === 1,
      log: (req, action, target, details) => log(req, action, target, details),
    });

    api.post<{ Params: { id: string } }>("/dashboard/api/users/:id/reset-2fa", { preHandler: need("users.manage") }, async (req) => {
      const u = ownUser(req, req.params.id);
      users.disableTotp("merchant", u.id);
      sessions.endForUser(u.id);
      log(req, "user.2fa_reset", u.id, { email: u.email });
      return { ok: true };
    });

    // Shop-wide security policy, set by whoever manages staff.
    api.patch("/dashboard/api/security", { preHandler: need("users.manage") }, async (req) => {
      const { require_2fa } = z.object({ require_2fa: z.boolean() }).parse(req.body);
      merchants.update(req.merchant!.id, { require_2fa });
      log(req, "merchant.security_policy", req.merchant!.id, { require_2fa });
      return { require_2fa };
    });

    // ---- linked bank account (incoming-money notifications) ----
    const notifyUrl = (id: string) => `${deps.publicBaseUrl}/bank/notify/${id}`;
    const connectSchema = z.object({
      label: z.string().min(1).max(120),
      biller_id: z.string().refine(isValidBillerId, "Biller ID ต้องเป็นตัวเลข 15 หลัก").nullable().optional(),
    });

    api.get("/dashboard/api/bank", { preHandler: need("settings.view") }, async (req) => {
      const c = bank.active(req.merchant!.id, req.livemode!);
      return {
        connection: c ? { ...serializeConnection(c), notify_url: notifyUrl(c.id) } : null,
        events: bank.events(req.merchant!.id, req.livemode!),
      };
    });

    api.post("/dashboard/api/bank", { preHandler: need("bank.manage") }, async (req, reply) => {
      const c = bank.connect(req.merchant!.id, req.livemode!, connectSchema.parse(req.body));
      log(req, "bank.connect", c.id, { label: c.label, biller: c.biller_id ? "yes" : "no" });
      return reply.code(201).send({ ...serializeConnection(c), notify_url: notifyUrl(c.id), secret: c.secret });
    });

    const activeOr404 = (req: FastifyRequest) => {
      const c = bank.active(req.merchant!.id, req.livemode!);
      if (!c) throw new PaymentError(404, "not_connected", "ยังไม่ได้เชื่อมบัญชีธนาคาร");
      return c;
    };

    api.post("/dashboard/api/bank/rotate-secret", { preHandler: need("bank.manage") }, async (req) => {
      const c = activeOr404(req);
      log(req, "bank.rotate_secret", c.id);
      return { secret: bank.rotateSecret(c.id) };
    });

    api.post("/dashboard/api/bank/disconnect", { preHandler: need("bank.manage") }, async (req) => {
      const c = activeOr404(req);
      bank.disconnect(c.id);
      log(req, "bank.disconnect", c.id);
      return { ok: true };
    });

    api.post<{ Params: { id: string } }>("/dashboard/api/bank/events/:id/assign", { preHandler: need("payments.review") }, async (req) => {
      const { payment_id } = z.object({ payment_id: z.string().max(64) }).parse(req.body);
      const r = bank.assign(req.merchant!.id, req.livemode!, req.params.id, own(req, payment_id));
      log(req, "bank.assign", payment_id, { event: req.params.id, outcome: r.outcome });
      return r;
    });

    api.patch("/dashboard/api/privacy", { preHandler: need("users.manage") }, async (req) => {
      const { privacy_url } = z.object({ privacy_url: z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u)).nullable() }).parse(req.body);
      merchants.update(req.merchant!.id, { privacy_url });
      log(req, "merchant.privacy_url", req.merchant!.id, { privacy_url });
      return { privacy_url };
    });

    // The shop's standing "I have paid" page for customers who transfer by account number.
    api.patch("/dashboard/api/notice", { preHandler: need("bank.manage") }, async (req) => {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      merchants.update(req.merchant!.id, { notice_enabled: enabled });
      log(req, enabled ? "notice.enable" : "notice.disable", req.merchant!.id);
      return { enabled, url: `${deps.publicBaseUrl}/notice/${req.merchant!.id}` };
    });

    api.post("/dashboard/api/bank/simulate", { preHandler: need("bank.manage") }, async (req) => {
      if (req.livemode) throw new PaymentError(400, "test_mode_only", "จำลองเงินเข้าได้เฉพาะโหมดทดสอบ");
      const { payment_id, amount } = z.object({ payment_id: z.string().max(64), amount: z.number().int().positive().optional() }).parse(req.body);
      return bank.simulate(activeOr404(req), own(req, payment_id), amount);
    });

    // ---- shop verification (self sign-up shops open live mode after review) ----
    const kycProfileSchema = z
      .object({
        name: z.string().min(1).max(120),
        business_type: z.enum(["individual", "company"]),
        tax_id: z.string().max(20),
        contact_name: z.string().min(1).max(120),
        contact_phone: z.string().min(9).max(20),
        promptpay_id: z.string().max(20).nullable(),
        bank_name: z.string().max(100).nullable(),
        bank_account_no: z.string().regex(/^[0-9-]{6,20}$/, "เลขบัญชีไม่ถูกต้อง").or(z.literal("")).nullable(),
        bank_account_name: z.string().max(120).nullable(),
      })
      .partial();
    const docView = (d: { id: string; kind: string; filename: string; mime: string; size: number; created_at: string }) => ({
      id: d.id, kind: d.kind, kind_label: KYC_DOCUMENT_KINDS[d.kind as KycDocumentKind] ?? d.kind, filename: d.filename, mime: d.mime, size: d.size, created_at: d.created_at,
    });

    api.get("/dashboard/api/kyc", async (req) => {
      const docs = kyc.documents(req.merchant!.id);
      return { merchant: serializeMerchant(req.merchant!), documents: docs.map(docView), missing: kycMissing(req.merchant!, docs), kinds: KYC_DOCUMENT_KINDS };
    });

    api.patch("/dashboard/api/kyc", { preHandler: need("users.manage") }, async (req) => {
      const m = kyc.updateProfile(req.merchant!, kycProfileSchema.parse(req.body));
      log(req, "kyc.update", m.id);
      return serializeMerchant(m);
    });

    api.post("/dashboard/api/kyc/documents", { preHandler: need("users.manage") }, async (req, reply) => {
      let kind = "";
      let file: { name: string; mime: string; data: Buffer; truncated: boolean } | null = null;
      for await (const part of req.parts({ limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 3 } })) {
        if (part.type === "file") file = { name: part.filename, mime: part.mimetype, data: await part.toBuffer(), truncated: part.file.truncated };
        else if (part.fieldname === "kind") kind = String(part.value);
      }
      if (!(kind in KYC_DOCUMENT_KINDS)) throw new PaymentError(400, "invalid_kind", "กรุณาเลือกประเภทเอกสาร");
      if (!file) throw new PaymentError(400, "invalid_file", "กรุณาแนบไฟล์");
      if (file.truncated) throw new PaymentError(413, "file_too_large", "ไฟล์ต้องไม่เกิน 5 MB");
      if (!looksLike(file.mime, file.data)) throw new PaymentError(400, "invalid_file", "ไฟล์ต้องเป็นรูปภาพ (JPG, PNG, WebP) หรือ PDF");
      const doc = kyc.addDocument(req.merchant!, kind as KycDocumentKind, file.name, file.mime, file.data);
      log(req, "kyc.document_added", doc.id, { kind });
      return reply.code(201).send(docView(doc));
    });

    api.get<{ Params: { id: string } }>("/dashboard/api/kyc/documents/:id", { preHandler: need("users.manage") }, async (req, reply) => {
      const { row, data } = kyc.document(req.merchant!.id, req.params.id);
      return reply.type(row.mime).header("Cache-Control", "private, no-store").send(data);
    });

    api.post<{ Params: { id: string } }>("/dashboard/api/kyc/documents/:id/delete", { preHandler: need("users.manage") }, async (req) => {
      kyc.removeDocument(req.merchant!, req.params.id);
      log(req, "kyc.document_removed", req.params.id);
      return { ok: true };
    });

    api.post("/dashboard/api/kyc/submit", { preHandler: need("users.manage") }, async (req) => {
      const m = kyc.submit(req.merchant!);
      log(req, "kyc.submitted", m.id);
      return serializeMerchant(m);
    });

    api.get("/dashboard/api/audit", { preHandler: need("audit.view") }, async (req) => {
      const { before } = z.object({ before: z.string().max(40).optional() }).parse(req.query);
      return { object: "list", data: audit.list({ merchantId: req.merchant!.id, before }, 50) };
    });
  });
}
