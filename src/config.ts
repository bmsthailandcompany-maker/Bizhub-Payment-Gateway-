import path from "node:path";

export interface Config {
  port: number;
  publicBaseUrl: string;
  adminToken: string;
  dataDir: string;
  defaultPaymentTtlSeconds: number;
  omise: { publicKey: string; secretKey: string } | null;
  /** Provider used to verify transfer slips for live payments; null means slips go to manual review. */
  slipVerifier:
    | { provider: "easyslip"; apiKey: string; baseUrl?: string }
    | { provider: "slipok"; branchId: string; apiKey: string }
    | null;
  /** Billing of shops: VAT, due days, the operator's own shop that receives invoice payments, and who issues invoices. */
  billing?: import("./services/billing.ts").BillingConfig;
  /** Lets shops sign up by themselves at /signup (they stay in test mode until approved). */
  signupEnabled?: boolean;
  /** Who runs this gateway, shown on the public privacy page. */
  operatorName?: string;
  operatorContact?: string | null;
  /** Delete slip images of closed payments after this many days (0 keeps them). */
  slipRetentionDays?: number;
  /** S3-compatible bucket that receives copies of backups and slips. */
  offsiteBackup?: import("./services/s3.ts").S3Config | null;
  /** Hours between automatic database backups into DATA_DIR/backups (0 disables). */
  backupIntervalHours?: number;
  /** How many backups to keep. */
  backupKeep?: number;
  /** Admin console accounts must set up two-factor authentication before using the console. */
  requireAdmin2fa: boolean;
  /** Interval for background jobs (webhook delivery, expiry sweep). 0 disables them. */
  workerIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adminToken = env.ADMIN_TOKEN ?? "";
  if (adminToken.length < 16) {
    throw new Error("ADMIN_TOKEN must be set and at least 16 characters long");
  }
  const omisePublic = env.OMISE_PUBLIC_KEY ?? "";
  const omiseSecret = env.OMISE_SECRET_KEY ?? "";
  return {
    slipVerifier: loadSlipVerifier(env),
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    adminToken,
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    defaultPaymentTtlSeconds: Number(env.DEFAULT_PAYMENT_TTL_SECONDS ?? 900),
    omise: omisePublic && omiseSecret ? { publicKey: omisePublic, secretKey: omiseSecret } : null,
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 5000),
    requireAdmin2fa: env.ADMIN_REQUIRE_2FA === "true",
    slipRetentionDays: Number(env.SLIP_RETENTION_DAYS ?? 0),
    signupEnabled: env.SIGNUP_ENABLED === "true",
    billing: {
      vatRateBps: Math.round(Number(env.VAT_RATE ?? 7) * 100),
      dueDays: Number(env.INVOICE_DUE_DAYS ?? 7),
      billingMerchantId: env.BILLING_MERCHANT_ID || null,
      issuer: { name: env.INVOICE_ISSUER_NAME || env.OPERATOR_NAME || "ผู้ให้บริการระบบ Bizhub", taxId: env.INVOICE_ISSUER_TAX_ID || null, address: env.INVOICE_ISSUER_ADDRESS || null },
    },
    operatorName: env.OPERATOR_NAME || "ผู้ให้บริการระบบ Bizhub",
    operatorContact: env.OPERATOR_CONTACT || null,
    backupIntervalHours: Number(env.BACKUP_INTERVAL_HOURS ?? 24),
    backupKeep: Number(env.BACKUP_KEEP ?? 14),
    offsiteBackup: loadOffsite(env),
  };
}

function loadSlipVerifier(env: NodeJS.ProcessEnv): Config["slipVerifier"] {
  const provider = (env.SLIP_VERIFIER ?? "").toLowerCase();
  if (!provider || provider === "none") return null;
  if (provider === "easyslip") {
    if (!env.EASYSLIP_API_KEY) throw new Error("SLIP_VERIFIER=easyslip requires EASYSLIP_API_KEY");
    return { provider, apiKey: env.EASYSLIP_API_KEY, baseUrl: env.EASYSLIP_BASE_URL || undefined };
  }
  if (provider === "slipok") {
    if (!env.SLIPOK_BRANCH_ID || !env.SLIPOK_API_KEY) {
      throw new Error("SLIP_VERIFIER=slipok requires SLIPOK_BRANCH_ID and SLIPOK_API_KEY");
    }
    return { provider, branchId: env.SLIPOK_BRANCH_ID, apiKey: env.SLIPOK_API_KEY };
  }
  throw new Error(`Unknown SLIP_VERIFIER '${provider}' (expected easyslip, slipok or none)`);
}

function loadOffsite(env: NodeJS.ProcessEnv): Config["offsiteBackup"] {
  const { BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY } = env;
  if (!BACKUP_S3_ENDPOINT && !BACKUP_S3_BUCKET) return null;
  if (!BACKUP_S3_ENDPOINT || !BACKUP_S3_BUCKET || !BACKUP_S3_ACCESS_KEY_ID || !BACKUP_S3_SECRET_ACCESS_KEY) {
    throw new Error("Off-site backup needs BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY");
  }
  return {
    endpoint: BACKUP_S3_ENDPOINT,
    bucket: BACKUP_S3_BUCKET,
    region: env.BACKUP_S3_REGION || "auto",
    accessKeyId: BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: BACKUP_S3_SECRET_ACCESS_KEY,
    prefix: env.BACKUP_S3_PREFIX || "bizhub",
  };
}
