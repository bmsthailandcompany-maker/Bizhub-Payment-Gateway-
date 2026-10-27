import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { openDb } from "./db.ts";
import { type CardProvider, MockCardProvider, OmiseCardProvider } from "./providers/card.ts";
import { adminRoutes } from "./routes/admin.ts";
import { checkoutRoutes, MAX_SLIP_BYTES } from "./routes/checkout.ts";
import { merchantApiRoutes } from "./routes/merchant-api.ts";
import { MerchantService } from "./services/merchants.ts";
import { PaymentError, PaymentService } from "./services/payments.ts";
import { WebhookService } from "./services/webhooks.ts";

export interface AppDeps {
  db?: Db;
  fetchImpl?: typeof fetch;
  liveCardProvider?: CardProvider | null;
  logger?: boolean;
}

export interface Gateway {
  app: FastifyInstance;
  db: Db;
  merchants: MerchantService;
  payments: PaymentService;
  webhooks: WebhookService;
  /** Runs one round of background work (expiry sweep + webhook delivery). */
  runJobs(): Promise<void>;
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<Gateway> {
  const db = deps.db ?? openDb(config.dataDir);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const liveCard =
    deps.liveCardProvider !== undefined
      ? deps.liveCardProvider
      : config.omise
        ? new OmiseCardProvider(config.omise.secretKey, fetchImpl)
        : null;

  const webhooks = new WebhookService(db, fetchImpl);
  const merchants = new MerchantService(db);
  const payments = new PaymentService(db, config, webhooks, { test: new MockCardProvider(), live: liveCard });

  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: 1024 * 1024, trustProxy: true });
  await app.register(multipart, { limits: { fileSize: MAX_SLIP_BYTES, files: 1, fields: 5 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof PaymentError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: "Invalid request",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "bad_request", message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  });

  app.get("/health", async () => ({ ok: true }));
  await app.register(merchantApiRoutes, { merchants, payments });
  await app.register(adminRoutes, { db, adminToken: config.adminToken, merchants, payments });
  await app.register(checkoutRoutes, { merchants, payments, omisePublicKey: config.omise?.publicKey ?? null });

  const runJobs = async () => {
    payments.sweepExpired();
    await webhooks.processDue();
  };

  return { app, db, merchants, payments, webhooks, runJobs };
}
