import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BankService } from "../services/bank.ts";
import { PaymentError } from "../services/payments.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const notificationSchema = z.object({
  trans_ref: z.string().min(1).max(100),
  amount: z.union([z.number(), z.string().max(20)]),
  paid_at: z.string().max(40).optional(),
  ref1: z.string().max(40).optional(),
  ref2: z.string().max(40).optional(),
  payer_name: z.string().max(200).optional(),
});

/**
 * Public endpoint a bank (or a relay forwarding the bank's alerts) calls for every incoming transfer.
 * Requests are signed with the connection's secret, the same scheme as the gateway's own webhooks.
 */
export async function bankNotifyRoutes(app: FastifyInstance, opts: { bank: BankService }) {
  // The signature covers the exact bytes sent, so keep the raw body next to the parsed one.
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 64 * 1024 }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new PaymentError(400, "invalid_json", "Body must be JSON"), undefined);
    }
  });

  app.post<{ Params: { id: string } }>("/bank/notify/:id", async (req, reply) => {
    const conn = opts.bank.get(req.params.id);
    if (!conn || conn.active !== 1) return reply.code(404).send({ error: { code: "not_found", message: "Unknown connection" } });
    const sig = req.headers["bizhub-signature"];
    if (!opts.bank.verifySignature(conn, typeof sig === "string" ? sig : undefined, req.rawBody ?? "")) {
      return reply.code(401).send({ error: { code: "invalid_signature", message: "Missing, expired or wrong Bizhub-Signature" } });
    }
    return opts.bank.handle(conn, notificationSchema.parse(req.body));
  });
}
