import { bahtToSatang, type SlipCheck, type SlipVerifier } from "./types.ts";

/** EasySlip API v1 (https://document.easyslip.com). */
export class EasySlipVerifier implements SlipVerifier {
  readonly name = "easyslip";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://developer.easyslip.com/api/v1",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async check(image: Buffer, mime: string): Promise<SlipCheck> {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(image)], { type: mime }), "slip");
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!json) return { kind: "retry", reason: `easyslip_http_${res.status}` };

    if (res.ok && json.data?.transRef) {
      const d = json.data;
      const acct = d.receiver?.account;
      return {
        kind: "slip",
        slip: {
          transRef: String(d.transRef),
          amount: bahtToSatang(Number(d.amount?.amount ?? d.amount)),
          paidAt: d.date ? new Date(d.date).toISOString() : null,
          receiver: {
            name: acct?.name?.th || acct?.name?.en || null,
            account: acct?.bank?.account || null,
            proxy: acct?.proxy?.account || null,
          },
          sender: {
            name: d.sender?.account?.name?.th || d.sender?.account?.name?.en || null,
            bank: d.sender?.bank?.short ?? d.sender?.bank?.id ?? null,
          },
          raw: json,
        },
      };
    }

    const message = String(json.message ?? "");
    if (["invalid_image", "image_size_too_large", "invalid_payload"].includes(message)) {
      return { kind: "invalid", reason: "invalid_image" };
    }
    if (message === "qrcode_not_found") return { kind: "invalid", reason: "qr_not_found" };
    if (message === "slip_not_found") return { kind: "invalid", reason: "transfer_not_found" };
    return { kind: "retry", reason: `easyslip_${message || res.status}` };
  }
}
