import path from "node:path";

export interface Config {
  port: number;
  publicBaseUrl: string;
  adminToken: string;
  dataDir: string;
  defaultPaymentTtlSeconds: number;
  omise: { publicKey: string; secretKey: string } | null;
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
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    adminToken,
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    defaultPaymentTtlSeconds: Number(env.DEFAULT_PAYMENT_TTL_SECONDS ?? 900),
    omise: omisePublic && omiseSecret ? { publicKey: omisePublic, secretKey: omiseSecret } : null,
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 5000),
  };
}
