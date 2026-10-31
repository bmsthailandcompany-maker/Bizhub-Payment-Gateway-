import type { VerifiedSlip } from "./types.ts";

export type SlipDecision =
  | { outcome: "verified" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "needs_review"; reason: string };

/** Slips dated earlier than this before the payment was created are treated as reused. */
const CLOCK_SKEW_MS = 10 * 60_000;

type MaskMatch = "match" | "mismatch" | "unknown";

/**
 * Compares a bank-masked number (e.g. "xxx-x-x5678-x") with a full number, right-aligned.
 * Any visible digit that disagrees is a mismatch; fewer than 3 visible digits is inconclusive.
 */
export function compareMasked(masked: string, full: string): MaskMatch {
  const m = masked.replace(/[^0-9xX*•]/g, "");
  const f = full.replace(/\D/g, "");
  let visible = 0;
  for (let i = 1; i <= m.length; i++) {
    const mc = m[m.length - i]!;
    if (!/\d/.test(mc)) continue;
    const fc = f[f.length - i];
    if (fc !== mc) return "mismatch";
    visible++;
  }
  return visible >= 3 ? "match" : "unknown";
}

/** All spellings a PromptPay ID may appear as on a slip. */
export function promptPayCandidates(id: string): string[] {
  const d = id.replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("0")) return [d, "66" + d.slice(1), "0066" + d.slice(1)];
  return [d];
}

function matchAny(masked: string | null, candidates: string[]): MaskMatch {
  if (!masked || candidates.length === 0) return "unknown";
  const results = candidates.map((c) => compareMasked(masked, c));
  if (results.includes("match")) return "match";
  if (results.every((r) => r === "mismatch")) return "mismatch";
  return "unknown";
}

export interface SlipTarget {
  method: "promptpay" | "bank_transfer";
  amount: number;
  createdAt: string;
  promptpayId: string | null;
  bankAccountNo: string | null;
}

/** Decides whether a bank-confirmed slip pays this particular payment. Duplicate use is checked separately. */
export function evaluateSlip(slip: VerifiedSlip, target: SlipTarget): SlipDecision {
  if (slip.amount < target.amount) return { outcome: "rejected", reason: "amount_too_low" };

  if (!slip.paidAt) return { outcome: "needs_review", reason: "slip_date_missing" };
  if (Date.parse(slip.paidAt) < Date.parse(target.createdAt) - CLOCK_SKEW_MS) {
    return { outcome: "rejected", reason: "slip_older_than_payment" };
  }

  const proxy = matchAny(slip.receiver.proxy, target.promptpayId ? promptPayCandidates(target.promptpayId) : []);
  const account = matchAny(slip.receiver.account, target.bankAccountNo ? [target.bankAccountNo] : []);
  if (proxy !== "match" && account !== "match") {
    // A PromptPay ID can be linked to any of the merchant's accounts, so for PromptPay only a
    // conflicting proxy is proof the money went elsewhere.
    const definitive = target.method === "promptpay" ? proxy === "mismatch" : proxy === "mismatch" || account === "mismatch";
    return definitive
      ? { outcome: "rejected", reason: "receiver_mismatch" }
      : { outcome: "needs_review", reason: "receiver_unverifiable" };
  }

  // Overpayment is real money for the merchant to sort out with the customer, not a silent success.
  if (slip.amount > target.amount) return { outcome: "needs_review", reason: "amount_too_high" };
  return { outcome: "verified" };
}
