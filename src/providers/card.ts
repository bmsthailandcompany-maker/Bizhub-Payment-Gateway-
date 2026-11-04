/**
 * Card acquirers are plugged in behind this interface. Card data never touches
 * the gateway: the checkout page tokenizes it in the browser and we only see the token.
 */
export interface CardChargeRequest {
  amount: number; // satang
  currency: string;
  token: string;
  description: string;
  returnUri: string;
  paymentId: string;
  /** Same key for every send of one charge attempt, so a re-send never creates a second charge. */
  idempotencyKey: string;
}

/**
 * Thrown by a provider. `definitive` means the provider answered and refused the request, so no
 * charge exists; otherwise (timeout, network error, provider 5xx) a charge may or may not exist.
 */
export class CardProviderError extends Error {
  constructor(
    message: string,
    public readonly definitive: boolean,
  ) {
    super(message);
  }
}

export interface CardChargeResult {
  status: "succeeded" | "failed" | "pending";
  providerRef: string | null;
  /** When set, the customer must be redirected here for 3-D Secure. */
  authorizeUri?: string;
  failureReason?: string;
}

export interface CardProvider {
  readonly name: string;
  charge(req: CardChargeRequest): Promise<CardChargeResult>;
  retrieve(providerRef: string): Promise<CardChargeResult>;
}

/**
 * Test-mode provider. Tokens look like `tok_test_<last4>`:
 * last4 0002 is declined, anything else succeeds.
 */
export class MockCardProvider implements CardProvider {
  readonly name = "mock";

  async charge(req: CardChargeRequest): Promise<CardChargeResult> {
    const match = /^tok_test_(\d{4})$/.exec(req.token);
    if (!match) return { status: "failed", providerRef: null, failureReason: "invalid_token" };
    const ref = `mock_ch_${req.paymentId}`;
    if (match[1] === "0002") return { status: "failed", providerRef: ref, failureReason: "card_declined" };
    return { status: "succeeded", providerRef: ref };
  }

  async retrieve(providerRef: string): Promise<CardChargeResult> {
    return { status: "succeeded", providerRef };
  }
}

/** Kept well below the payment lock window so a hung request never outlives the lock. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Omise / Opn Payments (https://docs.opn.ooo/charges-api). */
export class OmiseCardProvider implements CardProvider {
  readonly name = "omise";

  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(method: string, path: string, body?: Record<string, string>, idempotencyKey?: string): Promise<any> {
    let res: Response;
    let json: any;
    try {
      res = await this.fetchImpl(`https://api.omise.co${path}`, {
        method,
        headers: {
          Authorization: "Basic " + Buffer.from(this.secretKey + ":").toString("base64"),
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body ? new URLSearchParams(body).toString() : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      json = await res.json();
    } catch (err) {
      throw new CardProviderError(`Omise unreachable: ${err instanceof Error ? err.message : String(err)}`, false);
    }
    if (!res.ok) {
      // 4xx: Omise refused the request, so nothing was charged. 5xx: the outcome is unknown.
      throw new CardProviderError(`Omise ${json?.code ?? res.status}: ${json?.message ?? "request failed"}`, res.status < 500);
    }
    return json;
  }

  private toResult(charge: any): CardChargeResult {
    if (charge.status === "successful") return { status: "succeeded", providerRef: charge.id };
    if (charge.status === "failed" || charge.status === "expired" || charge.status === "reversed") {
      return { status: "failed", providerRef: charge.id, failureReason: charge.failure_code ?? charge.status };
    }
    return { status: "pending", providerRef: charge.id, authorizeUri: charge.authorize_uri ?? undefined };
  }

  async charge(req: CardChargeRequest): Promise<CardChargeResult> {
    const charge = await this.request("POST", "/charges", {
      amount: String(req.amount),
      currency: req.currency.toLowerCase(),
      card: req.token,
      description: req.description,
      return_uri: req.returnUri,
      "metadata[payment_id]": req.paymentId,
    }, req.idempotencyKey);
    return this.toResult(charge);
  }

  async retrieve(providerRef: string): Promise<CardChargeResult> {
    return this.toResult(await this.request("GET", `/charges/${encodeURIComponent(providerRef)}`));
  }
}
