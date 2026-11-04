import type { FastifyInstance } from "fastify";
import type { Db } from "../db.ts";
import { now } from "../db.ts";
import type { MerchantService } from "../services/merchants.ts";
import { serializeMerchant } from "../services/merchants.ts";
import type { PaymentService } from "../services/payments.ts";
import { PaymentError } from "../services/payments.ts";
import { adminAuth } from "./auth.ts";
import { createMerchantSchema, listPaymentsQuery, updateMerchantSchema } from "./schemas.ts";

export async function adminRoutes(
  app: FastifyInstance,
  opts: { db: Db; adminToken: string; merchants: MerchantService; payments: PaymentService },
) {
  const { db, merchants, payments } = opts;
  app.addHook("preHandler", adminAuth(opts.adminToken));

  const requireMerchant = (id: string) => {
    const m = merchants.get(id);
    if (!m) throw new PaymentError(404, "not_found", "Merchant not found");
    return m;
  };

  app.post("/admin/merchants", async (req, reply) => {
    const { merchant, keys } = merchants.create(createMerchantSchema.parse(req.body));
    // Secret keys are only ever shown here, at creation time.
    return reply.code(201).send({ ...serializeMerchant(merchant), webhook_secret: merchant.webhook_secret, ...keys });
  });

  app.get("/admin/merchants", async () => ({ object: "list", data: merchants.list().map(serializeMerchant) }));

  app.get<{ Params: { id: string } }>("/admin/merchants/:id", async (req) =>
    serializeMerchant(requireMerchant(req.params.id)),
  );

  app.patch<{ Params: { id: string } }>("/admin/merchants/:id", async (req) => {
    requireMerchant(req.params.id);
    return serializeMerchant(merchants.update(req.params.id, updateMerchantSchema.parse(req.body))!);
  });

  app.post<{ Params: { id: string } }>("/admin/merchants/:id/rotate-keys", async (req) => {
    requireMerchant(req.params.id);
    return merchants.rotateKeys(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/admin/merchants/:id/rotate-webhook-secret", async (req) => {
    requireMerchant(req.params.id);
    return { webhook_secret: merchants.rotateWebhookSecret(req.params.id) };
  });

  app.get("/admin/payments", async (req) => {
    const q = listPaymentsQuery.parse(req.query);
    const rows = payments.list(
      { merchantId: q.merchant_id, status: q.status, reference: q.reference },
      q.limit + 1,
      q.starting_after,
    );
    return {
      object: "list",
      data: rows.slice(0, q.limit).map((p) => ({ ...payments.serialize(p), merchant_id: p.merchant_id })),
      has_more: rows.length > q.limit,
    };
  });

  app.get("/admin/webhook-deliveries", async (req) => {
    const { status } = req.query as { status?: string };
    const rows = db
      .prepare(
        `SELECT d.id, d.event_id, e.type AS event_type, d.merchant_id, d.url, d.status, d.attempts,
                d.last_status_code, d.last_error, d.next_attempt_at, d.created_at
         FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
         ${status ? "WHERE d.status = ?" : ""} ORDER BY d.created_at DESC LIMIT 100`,
      )
      .all(...(status ? [status] : []));
    return { object: "list", data: rows };
  });

  app.post<{ Params: { id: string } }>("/admin/webhook-deliveries/:id/retry", async (req) => {
    const result = db
      .prepare("UPDATE webhook_deliveries SET status='pending', next_attempt_at=?, updated_at=? WHERE id=?")
      .run(now(), now(), req.params.id);
    if (result.changes === 0) throw new PaymentError(404, "not_found", "Delivery not found");
    return { id: req.params.id, status: "pending" };
  });
}
