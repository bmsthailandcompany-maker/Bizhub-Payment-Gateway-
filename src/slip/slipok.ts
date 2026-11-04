import { bahtToSatang, type SlipCheck, type SlipVerifier } from "./types.ts";

/** SlipOK (https://slipok.com). Error codes per the SlipOK API guide. */
export class SlipOkVerifier implements SlipVerifier {
  readonly name = "slipok";

  constructor(
    private readonly branchId: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async check(image: Buffer, mime: string): Promise<SlipCheck> {
    const form = new FormData();
    form.set("files", new Blob([new Uint8Array(image)], { type: mime }), "slip");
    const res = await this.fetchImpl(`https://api.slipok.com/api/line/apikey/${encodeURIComponent(this.branchId)}`, {
      method: "POST",
      headers: { "x-authorization": this.apiKey },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!json) return { kind: "retry", reason: `slipok_http_${res.status}` };

    // 1012-1014 only occur when SlipOK is asked to check log/amount itself; we do those checks
    // ourselves, but if they appear the slip data is still valid to evaluate.
    if (json.data?.transRef && (json.success === true || [1012, 1013, 1014].includes(json.code))) {
      const d = json.data;
      return {
        kind: "slip",
        slip: {
          transRef: String(d.transRef),
          amount: bahtToSatang(Number(d.amount)),
          paidAt: d.transTimestamp ? new Date(d.transTimestamp).toISOString() : null,
          receiver: {
            name: d.receiver?.displayName || d.receiver?.name || null,
            account: d.receiver?.account?.value || null,
            proxy: d.receiver?.proxy?.value || null,
          },
          sender: { name: d.sender?.displayName || d.sender?.name || null, bank: d.sendingBank ?? null },
          raw: json,
        },
      };
    }

    switch (json.code) {
      case 1005:
      case 1006:
        return { kind: "invalid", reason: "invalid_image" };
      case 1007:
        return { kind: "invalid", reason: "qr_not_found" };
      case 1008:
        return { kind: "invalid", reason: "not_a_payment_slip" };
      case 1011:
        return { kind: "invalid", reason: "transfer_not_found" };
      case 1009:
        return { kind: "retry", reason: "bank_unavailable", retryAfterSeconds: 15 * 60 };
      case 1010:
        return { kind: "retry", reason: "bank_delay", retryAfterSeconds: Math.max(1, Number(json.data?.delay ?? 5)) * 60 };
      default:
        // 1000-1004: request/account/quota problems on our side.
        return { kind: "retry", reason: `slipok_error_${json.code ?? res.status}` };
    }
  }
}
