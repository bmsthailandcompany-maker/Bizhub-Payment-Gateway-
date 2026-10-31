import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuditService } from "../services/audit.ts";
import { PaymentError } from "../services/payments.ts";
import type { LoginLimiter, SessionKind, SessionService } from "../services/sessions.ts";
import type { UserScope, UserService } from "../services/users.ts";
import { csrfOk, setSessionCookie } from "./web-session.ts";

const codeSchema = z.object({ code: z.string().min(6).max(20) });

/** Paths a signed-in user may still call while 2FA is required but not yet set up. */
export function mfaSetupPaths(base: string): string[] {
  return [`${base}/me`, `${base}/2fa`, `${base}/2fa/setup`, `${base}/2fa/confirm`];
}

/**
 * Second step of a password login: exchanges the pending ticket plus a 6-digit (or recovery)
 * code for a real session. Wrong codes are rate limited per user.
 */
export function registerMfaLogin(
  app: FastifyInstance,
  opts: {
    base: string;
    kind: SessionKind;
    scope: UserScope;
    cookie: { name: string; path: string };
    users: UserService;
    sessions: SessionService;
    audit: AuditService;
    limiter: LoginLimiter;
    /** Creates the real session for this user once both factors passed. */
    startSession: (userId: string, merchantId: string | null) => string | undefined;
  },
) {
  const { users, sessions, audit, limiter } = opts;
  app.post(`${opts.base}/login/2fa`, async (req, reply) => {
    if (!csrfOk(req)) throw new PaymentError(403, "forbidden", "Missing header");
    const body = z.object({ mfa_token: z.string().min(1).max(200), code: z.string().min(1).max(20) }).parse(req.body);
    const pending = sessions.peekPending(opts.kind, body.mfa_token);
    if (!pending) throw new PaymentError(401, "mfa_expired", "หมดเวลายืนยันตัวตน กรุณาเข้าสู่ระบบใหม่");
    const key = `2fa|${pending.userId}`;
    if (limiter.blocked(key)) throw new PaymentError(429, "too_many_attempts", "ใส่รหัสผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่");
    const u = users.get(opts.scope, pending.userId);
    const method = u ? users.verifySecondFactor(opts.scope, u.id, body.code) : null;
    const actor = { kind: opts.scope === "merchant" ? "merchant_user" : "admin_user", id: u?.id ?? null, name: u?.name ?? "?", role: u?.role ?? "", mustChangePassword: false } as const;
    if (!u || !method) {
      limiter.fail(key);
      audit.log({ merchantId: pending.merchantId, actor, action: opts.scope === "merchant" ? "auth.2fa_failed" : "admin.2fa_failed", ip: req.ip });
      throw new PaymentError(401, "invalid_code", "รหัสยืนยันไม่ถูกต้อง");
    }
    limiter.succeed(key);
    sessions.end(body.mfa_token);
    const token = opts.startSession(u.id, pending.merchantId);
    if (!token) throw new PaymentError(401, "unauthorized", "บัญชีนี้ใช้งานไม่ได้");
    users.touchLogin(opts.scope, u.id);
    audit.log({
      merchantId: pending.merchantId,
      actor,
      action: opts.scope === "merchant" ? "auth.login" : "admin.login",
      details: { second_factor: method, ...(method === "recovery" ? { recovery_codes_left: users.recoveryCodesLeft(opts.scope, u.id) } : {}) },
      ip: req.ip,
    });
    setSessionCookie(req, reply, opts.cookie.name, opts.cookie.path, token);
    return { ok: true, used_recovery_code: method === "recovery" };
  });
}

/** Self-service 2FA endpoints for a signed-in user (registered inside the authenticated scope). */
export function registerMfaSelfService(
  api: FastifyInstance,
  opts: {
    base: string;
    scope: UserScope;
    issuer: (req: FastifyRequest) => string;
    users: UserService;
    sessions: SessionService;
    /** Whether policy forbids this user from turning 2FA off. */
    required: (req: FastifyRequest) => boolean;
    log: (req: FastifyRequest, action: string, target?: string, details?: Record<string, unknown>) => void;
  },
) {
  const { users } = opts;
  const userId = (req: FastifyRequest, reply: FastifyReply): string | undefined => {
    const kind = opts.scope === "merchant" ? "merchant_user" : "admin_user";
    if (req.actor!.kind !== kind) {
      reply.code(400).send({ error: { code: "not_a_user", message: "2FA ใช้ได้กับบัญชีผู้ใช้เท่านั้น (ไม่ใช่การเข้าด้วย key/token)" } });
      return undefined;
    }
    return req.actor!.id!;
  };

  api.get(`${opts.base}/2fa`, async (req, reply) => {
    const id = userId(req, reply);
    if (!id) return reply;
    const u = users.get(opts.scope, id)!;
    return { enabled: u.totp_enabled === 1, recovery_codes_left: users.recoveryCodesLeft(opts.scope, id), required: opts.required(req) };
  });

  api.post(`${opts.base}/2fa/setup`, async (req, reply) => {
    const id = userId(req, reply);
    if (!id) return reply;
    return users.beginTotp(opts.scope, id, opts.issuer(req));
  });

  api.post(`${opts.base}/2fa/confirm`, async (req, reply) => {
    const id = userId(req, reply);
    if (!id) return reply;
    const codes = users.confirmTotp(opts.scope, id, codeSchema.parse(req.body).code);
    opts.log(req, opts.scope === "merchant" ? "user.2fa_enabled" : "admin_user.2fa_enabled", id);
    return { recovery_codes: codes };
  });

  api.post(`${opts.base}/2fa/recovery-codes`, async (req, reply) => {
    const id = userId(req, reply);
    if (!id) return reply;
    const codes = users.regenerateRecoveryCodes(opts.scope, id, codeSchema.parse(req.body).code);
    opts.log(req, opts.scope === "merchant" ? "user.2fa_recovery_regenerated" : "admin_user.2fa_recovery_regenerated", id);
    return { recovery_codes: codes };
  });

  api.post(`${opts.base}/2fa/disable`, async (req, reply) => {
    const id = userId(req, reply);
    if (!id) return reply;
    if (opts.required(req)) throw new PaymentError(409, "2fa_required", "นโยบายความปลอดภัยกำหนดให้ต้องใช้ 2FA ปิดไม่ได้");
    users.disableTotp(opts.scope, id, codeSchema.parse(req.body).code);
    opts.log(req, opts.scope === "merchant" ? "user.2fa_disabled" : "admin_user.2fa_disabled", id);
    return { ok: true };
  });
}
