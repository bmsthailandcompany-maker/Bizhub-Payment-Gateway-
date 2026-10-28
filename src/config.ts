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
