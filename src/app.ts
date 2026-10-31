import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { openDb } from "./db.ts";
import { type CardProvider, MockCardProvider, OmiseCardProvider } from "./providers/card.ts";
import { adminRoutes } from "./routes/admin.ts";
import { checkoutRoutes, MAX_SLIP_BYTES } from "./routes/checkout.ts";
import { adminConsoleRoutes } from "./routes/admin-console.ts";
import { assetRoutes } from "./routes/assets.ts";
import { bankNotifyRoutes } from "./routes/bank.ts";
import { legalRoutes } from "./routes/legal.ts";
import { noticeRoutes } from "./routes/notice.ts";
import { signupRoutes } from "./routes/signup.ts";
import { KycService } from "./services/kyc.ts";
import { BillingService } from "./services/billing.ts";
import { BankService } from "./services/bank.ts";
import { MaintenanceService } from "./services/maintenance.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { AuditService } from "./services/audit.ts";
import { LoginLimiter, SessionService } from "./services/sessions.ts";
import { UserService } from "./services/users.ts";
import { merchantApiRoutes } from "./routes/merchant-api.ts";
import { MerchantService } from "./services/merchants.ts";
import { PaymentError, PaymentService } from "./services/payments.ts";
import { SlipService } from "./services/slips.ts";
import { WebhookService } from "./services/webhooks.ts";
import { EasySlipVerifier } from "./slip/easyslip.ts";
import { MockSlipVerifier } from "./slip/mock.ts";
import { SlipOkVerifier } from "./slip/slipok.ts";
import type { SlipVerifier } from "./slip/types.ts";

export interface AppDeps {
  db?: Db;
  fetchImpl?: typeof fetch;
  liveCardProvider?: CardProvider | null;
  liveSlipVerifier?: SlipVerifier | null;
  logger?: boolean;
}

export interface Gateway {
  app: FastifyInstance;
  db: Db;
  merchants: MerchantService;
  payments: PaymentService;
  webhooks: WebhookService;
  slips: SlipService;
  users: UserService;
  audit: AuditService;
  bank: BankService;
  maintenance: MaintenanceService;
  billing: BillingService;
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

  const sv = config.slipVerifier;
  const liveSlip =
    deps.liveSlipVerifier !== undefined
      ? deps.liveSlipVerifier
      : sv?.provider === "easyslip"
        ? new EasySlipVerifier(sv.apiKey, sv.baseUrl, fetchImpl)
        : sv?.provider === "slipok"
          ? new SlipOkVerifier(sv.branchId, sv.apiKey, fetchImpl)
          : null;

  const webhooks = new WebhookService(db, fetchImpl);
  const merchants = new MerchantService(db);
  const payments = new PaymentService(db, config, webhooks, { test: new MockCardProvider(), live: liveCard });
  const slips = new SlipService(db, payments, merchants, { test: new MockSlipVerifier(), live: liveSlip });
  const users = new UserService(db);
  const sessions = new SessionService(db, config.adminToken, config.requireAdmin2fa);
  const audit = new AuditService(db);
  const limiter = new LoginLimiter();
  const bank = new BankService(db, payments, audit);
  const kyc = new KycService(db, merchants, users, config.dataDir);
  const billing = new BillingService(db, merchants, payments, config.billing ?? {
    vatRateBps: 700,
    dueDays: 7,
    billingMerchantId: null,
    issuer: { name: config.operatorName ?? "ผู้ให้บริการระบบ Bizhub", taxId: null, address: null },
  });
  const maintenance = new MaintenanceService(db, {
    dataDir: config.dataDir,
    slipDir: payments.slipDir,
    slipRetentionDays: config.slipRetentionDays ?? 0,
    backupIntervalHours: config.backupIntervalHours ?? 0,
    backupKeep: config.backupKeep ?? 14,
    offsite: config.offsiteBackup ?? null,
    fetchImpl,
  });

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
  app.get("/", async (_req, reply) => reply.redirect("/dashboard"));
  await app.register(merchantApiRoutes, { merchants, payments, slips });
  await app.register(adminRoutes, { db, adminToken: config.adminToken, merchants, payments });
  await app.register(assetRoutes);
  await app.register(dashboardRoutes, {
    db,
    merchants,
    payments,
    slips,
    users,
    sessions,
    audit,
    limiter,
    bank,
    kyc,
    billing,
    publicBaseUrl: config.publicBaseUrl,
  });
  await app.register(signupRoutes, { enabled: config.signupEnabled ?? false, kyc, sessions, audit });
  await app.register(bankNotifyRoutes, { bank });
  await app.register(legalRoutes, {
    operatorName: config.operatorName ?? "ผู้ให้บริการระบบ Bizhub",
    operatorContact: config.operatorContact ?? null,
  });
  await app.register(noticeRoutes, { merchants, payments, slips, audit, publicBaseUrl: config.publicBaseUrl });
  await app.register(adminConsoleRoutes, {
    db,
    adminToken: config.adminToken,
    merchants,
    payments,
    slips,
    users,
    sessions,
    audit,
    limiter,
    requireAdmin2fa: config.requireAdmin2fa,
    bank,
    kyc,
    billing,
  });
  await app.register(checkoutRoutes, { merchants, payments, slips, omisePublicKey: config.omise?.publicKey ?? null });

  const runJobs = async () => {
    payments.sweepExpired();
    await slips.retryDue();
    const invoiced = billing.runMonthly();
    if (invoiced) app.log.info({ count: invoiced }, "monthly invoices issued");
    const m = await maintenance.run();
    if (m.backup) app.log.info({ file: m.backup }, "database backup written");
    if (m.purged) app.log.info({ count: m.purged }, "old slip images deleted under the retention policy");
    if (m.uploaded) app.log.info({ count: m.uploaded }, "files copied to off-site backup");
    if (m.offsiteError) app.log.error({ error: m.offsiteError }, "off-site backup failed; will retry");
    await webhooks.processDue();
  };

  return { app, db, merchants, payments, webhooks, slips, users, audit, bank, maintenance, billing, runJobs };
}
