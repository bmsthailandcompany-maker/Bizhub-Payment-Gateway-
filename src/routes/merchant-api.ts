import type { FastifyInstance } from "fastify";
import type { MerchantService } from "../services/merchants.ts";
import { serializeMerchant } from "../services/merchants.ts";
import type { PaymentService } from "../services/payments.ts";
import { PaymentError } from "../services/payments.ts";
import { merchantAuth } from "./auth.ts";
import { createPaymentSchema, listPaymentsQuery, rejectSchema, simulateSchema } from "./schemas.ts";

export async function merchantApiRoutes(
  app: FastifyInstance,
  opts: { merchants: MerchantService; payments: PaymentService },
) {
  const { merchants, payments } = opts;
  app.addHook("preHandler", merchantAuth(merchants));

  const own = (req: { merchant?: { id: string }; livemode?: boolean }, id: string) =>
    payments.expireIfDue(payments.getForMerchant(id, req.merchant!.id, req.livemode!));

  app.get("/v1/merchant", async (req) => ({
    ...serializeMerchant(req.merchant!),
    livemode: req.livemode,
    webhook_secret: req.merchant!.webhook_secret,
  }));

  app.post("/v1/payments", async (req, reply) => {
    const input = createPaymentSchema.parse(req.body);
    const rawKey = req.headers["idempotency-key"];
    const idempotencyKey = typeof rawKey === "string" && rawKey.length > 0 ? rawKey.slice(0, 255) : undefined;
    const payment = payments.create(req.merchant!, req.livemode!, input, idempotencyKey);
    return reply.code(201).send(payments.serialize(payment));
  });

  app.get("/v1/payments", async (req) => {
    const q = listPaymentsQuery.parse(req.query);
    const rows = payments.list(
      { merchantId: req.merchant!.id, livemode: req.livemode!, status: q.status, reference: q.reference },
      q.limit + 1,
      q.starting_after,
    );
    return {
      object: "list",
      data: rows.slice(0, q.limit).map((p) => payments.serialize(p)),
      has_more: rows.length > q.limit,
    };
  });

  app.get<{ Params: { id: string } }>("/v1/payments/:id", async (req) => payments.serialize(own(req, req.params.id)));

  app.post<{ Params: { id: string } }>("/v1/payments/:id/cancel", async (req) => {
    own(req, req.params.id);
    return payments.serialize(payments.transition(req.params.id, "cancelled"));
  });

  // PromptPay and bank transfers settle directly into the merchant's account, so the
  // merchant confirms receipt (typically after checking the uploaded slip).
  app.post<{ Params: { id: string } }>("/v1/payments/:id/approve", async (req) => {
    const p = own(req, req.params.id);
    if (p.method === "card") throw new PaymentError(400, "invalid_method", "Card payments are confirmed by the card provider");
    return payments.serialize(payments.transition(p.id, "succeeded"));
  });

  app.post<{ Params: { id: string } }>("/v1/payments/:id/reject", async (req) => {
    const p = own(req, req.params.id);
    const { reason } = rejectSchema.parse(req.body ?? {});
    if (p.status !== "awaiting_review") {
      throw new PaymentError(409, "invalid_state", "Only payments awaiting review can be rejected");
    }
    return payments.serialize(payments.transition(p.id, "failed", { failure_reason: reason }));
  });

  app.get<{ Params: { id: string } }>("/v1/payments/:id/slip", async (req, reply) => {
    const slip = payments.readSlip(own(req, req.params.id));
    if (!slip) throw new PaymentError(404, "not_found", "No slip uploaded for this payment");
    return reply.type(slip.mime).header("Cache-Control", "private, no-store").send(slip.data);
  });

  app.post<{ Params: { id: string } }>("/v1/payments/:id/simulate", async (req) => {
    if (req.livemode) throw new PaymentError(400, "test_mode_only", "Simulation is only available with test keys");
    const p = own(req, req.params.id);
    const { status } = simulateSchema.parse(req.body);
    return payments.serialize(
      payments.transition(p.id, status, status === "failed" ? { failure_reason: "simulated_failure" } : {}),
    );
  });
}
