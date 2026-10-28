import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db.ts";
import type { MerchantService } from "../services/merchants.ts";
import { serializeMerchant } from "../services/merchants.ts";
import type { PaymentService } from "../services/payments.ts";
import { PaymentError } from "../services/payments.ts";
import type { SlipService } from "../services/slips.ts";
import { renderDashboardPage } from "./dashboard-page.ts";
import { createPaymentSchema, listPaymentsQuery, rejectSchema } from "./schemas.ts";

const COOKIE = "bizhub_session";
const SESSION_TTL_MS = 12 * 3600_000;

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function sessionCookie(req: FastifyRequest, value: string, maxAgeS: number): string {
  const secure = req.protocol === "https" ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure}`;
}

/**
 * Merchant dashboard: a single page plus a cookie-session JSON API under /dashboard/api.
 * Merchants sign in with their secret key once; the browser then only holds an HttpOnly session.
 */
export async function dashboardRoutes(
  app: FastifyInstance,
  opts: { db: Db; merchants: MerchantService; payments: PaymentService; slips: SlipService },
) {
  const { db, merchants, payments, slips } = opts;

  app.get("/dashboard", async (_req, reply) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    return reply
      .type("text/html; charset=utf-8")
      .header(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data: blob:; ` +
          `connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      )
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .send(renderDashboardPage(nonce));
  });

  app.post("/dashboard/api/login", async (req, reply) => {
    const { secret_key } = z.object({ secret_key: z.string().min(1).max(200) }).parse(req.body);
    const session = merchants.createSession(secret_key.trim(), SESSION_TTL_MS);
    if (!session) throw new PaymentError(401, "unauthorized", "Invalid secret key");
    return reply
      .header("Set-Cookie", sessionCookie(req, session.token, SESSION_TTL_MS / 1000))
      .send({ ok: true, livemode: session.livemode });
  });

  app.post("/dashboard/api/logout", async (req, reply) => {
    const token = readCookie(req, COOKIE);
    if (token) merchants.endSession(token);
    return reply.header("Set-Cookie", sessionCookie(req, "", 0)).send({ ok: true });
  });

  // Everything below needs a session.
  await app.register(async (api) => {
    api.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      const token = readCookie(req, COOKIE);
      const auth = token ? merchants.authenticateSession(token) : undefined;
      if (!auth) return reply.code(401).send({ error: { code: "unauthorized", message: "Please sign in" } });
      // SameSite=Strict already blocks cross-site cookies; this header check is defence in depth for writes.
      if (req.method !== "GET" && req.headers["x-requested-with"] !== "bizhub-dashboard") {
        return reply.code(403).send({ error: { code: "forbidden", message: "Missing dashboard header" } });
      }
      req.merchant = auth.merchant;
      req.livemode = auth.livemode;
    });

    const own = (req: FastifyRequest, id: string) =>
      payments.expireIfDue(payments.getForMerchant(id, req.merchant!.id, req.livemode!));

    api.get("/dashboard/api/me", async (req) => ({
      merchant: serializeMerchant(req.merchant!),
      livemode: req.livemode,
      webhook_secret: req.merchant!.webhook_secret,
    }));

    api.get("/dashboard/api/summary", async (req) => payments.summary(req.merchant!.id, req.livemode!));

    api.get("/dashboard/api/payments", async (req) => {
      const q = listPaymentsQuery.extend({ q: z.string().max(100).optional() }).parse(req.query);
      const rows = payments.list(
        { merchantId: req.merchant!.id, livemode: req.livemode!, status: q.status, search: q.q?.trim() || undefined },
        q.limit + 1,
        q.starting_after,
      );
      return {
        object: "list",
        data: rows.slice(0, q.limit).map((p) => payments.serialize(p)),
        has_more: rows.length > q.limit,
      };
    });

    api.post("/dashboard/api/payments", async (req, reply) => {
      const input = createPaymentSchema.parse(req.body);
      return reply.code(201).send(payments.serialize(payments.create(req.merchant!, req.livemode!, input)));
    });

    api.get<{ Params: { id: string } }>("/dashboard/api/payments/:id", async (req) => {
      const p = own(req, req.params.id);
      return { ...payments.serialize(p), slip_checks: slips.history(p.id) };
    });

    api.get<{ Params: { id: string } }>("/dashboard/api/payments/:id/slip", async (req, reply) => {
      const slip = payments.readSlip(own(req, req.params.id));
      if (!slip) throw new PaymentError(404, "not_found", "No slip uploaded for this payment");
      return reply.type(slip.mime).header("Cache-Control", "private, no-store").send(slip.data);
    });

    api.post<{ Params: { id: string } }>("/dashboard/api/payments/:id/approve", async (req) =>
      payments.serialize(payments.approve(own(req, req.params.id))),
    );

    api.post<{ Params: { id: string } }>("/dashboard/api/payments/:id/reject", async (req) => {
      const { reason } = rejectSchema.parse(req.body ?? {});
      return payments.serialize(payments.reject(own(req, req.params.id), reason));
    });

    api.post<{ Params: { id: string } }>("/dashboard/api/payments/:id/cancel", async (req) =>
      payments.serialize(payments.transition(own(req, req.params.id).id, "cancelled")),
    );

    api.get("/dashboard/api/webhooks", async (req) => ({
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
  });
}
