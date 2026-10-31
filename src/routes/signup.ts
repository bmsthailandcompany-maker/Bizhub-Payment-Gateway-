import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuditService } from "../services/audit.ts";
import type { KycService } from "../services/kyc.ts";
import { PaymentError } from "../services/payments.ts";
import { LoginLimiter, type SessionService } from "../services/sessions.ts";
import { COOKIE, COOKIE_PATH } from "./dashboard.ts";
import { appShell, csrfOk, pageHeaders, setSessionCookie } from "./web-session.ts";

const signupSchema = z.object({
  business_name: z.string().trim().min(1).max(120),
  contact_name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().regex(/^[0-9+\- ]{9,20}$/, "เบอร์โทรไม่ถูกต้อง"),
  password: z.string().min(1).max(200),
  accept_terms: z.literal(true, { message: "กรุณายอมรับเงื่อนไขการใช้บริการ" }),
});

/**
 * Public self sign-up (only when SIGNUP_ENABLED). The new shop's owner is signed straight into
 * the dashboard in test mode and completes verification there before live mode opens.
 */
export async function signupRoutes(
  app: FastifyInstance,
  opts: { enabled: boolean; kyc: KycService; sessions: SessionService; audit: AuditService },
) {
  const limiter = new LoginLimiter(5, 60 * 60_000);

  app.get("/signup", async (_req, reply) => {
    if (!opts.enabled) return reply.code(404).type("text/html; charset=utf-8").send("<!doctype html><meta charset=utf-8><p>ยังไม่เปิดรับสมัครร้านค้า</p>");
    return pageHeaders(reply).send(appShell("สมัครใช้งาน Bizhub", "signup.js"));
  });

  app.post("/signup/api", async (req, reply) => {
    if (!opts.enabled) throw new PaymentError(404, "signup_closed", "ยังไม่เปิดรับสมัครร้านค้า");
    if (!csrfOk(req)) throw new PaymentError(403, "forbidden", "Missing header");
    if (limiter.blocked(req.ip)) throw new PaymentError(429, "too_many_attempts", "สมัครหลายครั้งเกินไป กรุณารอสักครู่");
    limiter.fail(req.ip);
    const body = signupSchema.parse(req.body);
    const { merchant, user } = await opts.kyc.signup(body);
    opts.audit.log({
      merchantId: merchant.id,
      actor: { kind: "merchant_user", id: user.id, name: user.name, role: "owner", mustChangePassword: false },
      action: "merchant.signup",
      target: merchant.id,
      details: { name: merchant.name, email: user.email },
      ip: req.ip,
    });
    const token = opts.sessions.create({ kind: "merchant", merchantId: merchant.id, userId: user.id, livemode: false });
    setSessionCookie(req, reply, COOKIE, COOKIE_PATH, token);
    return reply.code(201).send({ ok: true, merchant_id: merchant.id });
  });
}
