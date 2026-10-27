import { z } from "zod";
import { isValidPromptPayId } from "../promptpay.ts";

const httpUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL");

export const createPaymentSchema = z.object({
  /** Amount in satang (1 THB = 100). Minimum 1 THB, maximum 2,000,000 THB. */
  amount: z.number().int().min(100).max(200_000_000),
  currency: z.literal("THB").default("THB"),
  method: z.enum(["promptpay", "card", "bank_transfer"]),
  reference: z.string().max(100).optional(),
  description: z.string().max(255).optional(),
  metadata: z.record(z.string().max(40), z.string().max(500)).refine((m) => Object.keys(m).length <= 20, "max 20 keys").optional(),
  return_url: httpUrl.optional(),
  /** Seconds until the payment expires (1 minute – 7 days). */
  expires_in: z.number().int().min(60).max(7 * 86400).optional(),
});

export const listPaymentsQuery = z.object({
  status: z.enum(["pending", "awaiting_review", "succeeded", "failed", "expired", "cancelled"]).optional(),
  reference: z.string().max(100).optional(),
  merchant_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.string().max(64).optional(),
});

export const rejectSchema = z.object({ reason: z.string().max(255).default("rejected_by_merchant") });

export const simulateSchema = z.object({ status: z.enum(["succeeded", "failed"]) });

export const cardChargeSchema = z.object({ token: z.string().min(1).max(200) });

const merchantFields = {
  name: z.string().min(1).max(120),
  promptpay_id: z.string().refine(isValidPromptPayId, "invalid PromptPay ID").nullable().optional(),
  bank_name: z.string().max(100).nullable().optional(),
  bank_account_no: z.string().regex(/^[0-9-]{6,20}$/, "invalid account number").nullable().optional(),
  bank_account_name: z.string().max(120).nullable().optional(),
  webhook_url: httpUrl.nullable().optional(),
};

export const createMerchantSchema = z.object(merchantFields);
export const updateMerchantSchema = z.object({ ...merchantFields, active: z.boolean() }).partial();
