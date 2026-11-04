/** A slip as read back from the bank network by a verification provider, normalized. */
export interface VerifiedSlip {
  transRef: string;
  /** Amount in satang. */
  amount: number;
  /** ISO timestamp of the transfer, if the provider returned one. */
  paidAt: string | null;
  receiver: {
    name: string | null;
    /** Bank account number as printed by the bank, usually partly masked (e.g. "xxx-x-x5678-x"). */
    account: string | null;
    /** PromptPay proxy (mobile / ID / e-wallet), usually partly masked. */
    proxy: string | null;
  };
  sender: { name: string | null; bank: string | null };
  raw: unknown;
}

export type SlipCheck =
  /** The bank confirmed this transfer exists. Whether it pays *this* payment is decided by `evaluateSlip`. */
  | { kind: "slip"; slip: VerifiedSlip }
  /** Definitely not a usable slip (no QR, not a payment slip, transfer does not exist). */
  | { kind: "invalid"; reason: string }
  /** Could not decide right now (bank delay, provider outage, quota). Try again later. */
  | { kind: "retry"; reason: string; retryAfterSeconds?: number };

/** What the gateway expects the slip to show. Real providers ignore it; the test-mode mock echoes it. */
export interface SlipExpectation {
  amount: number;
  receiverAccount: string | null;
  receiverProxy: string | null;
}

export interface SlipVerifier {
  readonly name: string;
  check(image: Buffer, mime: string, expected: SlipExpectation): Promise<SlipCheck>;
}

export function bahtToSatang(baht: number): number {
  return Math.round(baht * 100);
}
