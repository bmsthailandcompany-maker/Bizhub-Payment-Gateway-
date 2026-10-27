import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import type { MerchantService } from "../services/merchants.ts";
import type { PaymentService } from "../services/payments.ts";
import { PaymentError } from "../services/payments.ts";
import { renderCheckoutPage } from "./checkout-page.ts";
import { cardChargeSchema } from "./schemas.ts";

export const MAX_SLIP_BYTES = 5 * 1024 * 1024;

/** Public, customer-facing endpoints. The unguessable payment ID acts as the capability. */
export async function checkoutRoutes(
  app: FastifyInstance,
  opts: { merchants: MerchantService; payments: PaymentService; omisePublicKey: string | null },
) {
  const { merchants, payments } = opts;

  const load = (id: string) => {
    const p = payments.get(id);
    if (!p) throw new PaymentError(404, "not_found", "Payment not found");
    return payments.expireIfDue(p);
  };

  app.get<{ Params: { id: string } }>("/checkout/:id", async (req, reply) => {
    let p;
    try {
      p = load(req.params.id);
    } catch (err) {
      if (err instanceof PaymentError && err.statusCode === 404) {
        return reply.code(404).type("text/html; charset=utf-8").send("<!doctype html><meta charset=utf-8><p>ไม่พบรายการชำระเงิน</p>");
      }
      throw err;
    }
    const nonce = crypto.randomBytes(16).toString("base64");
    return reply
      .type("text/html; charset=utf-8")
      .header(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'nonce-${nonce}' https://cdn.omise.co; style-src 'nonce-${nonce}'; ` +
          `img-src 'self' data:; connect-src 'self' https://*.omise.co; frame-src https://*.omise.co; ` +
          `frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      )
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .send(renderCheckoutPage({ payment: p, merchant: merchants.get(p.merchant_id)!, nonce, omisePublicKey: opts.omisePublicKey }));
  });

  app.get<{ Params: { id: string } }>("/checkout/:id/status", async (req, reply) => {
    const p = load(req.params.id);
    reply.header("Cache-Control", "no-store");
    return { id: p.id, status: p.status };
  });

  app.get<{ Params: { id: string } }>("/checkout/:id/qr.png", async (req, reply) => {
    const p = load(req.params.id);
    if (!p.promptpay_payload) throw new PaymentError(404, "not_found", "This payment has no PromptPay QR");
    // Never hand out a scannable QR for a payment that can no longer be accepted.
    if (p.status !== "pending") throw new PaymentError(410, "gone", `Payment is ${p.status}`);
    const png = await QRCode.toBuffer(p.promptpay_payload, { type: "png", width: 560, margin: 1, errorCorrectionLevel: "M" });
    return reply.type("image/png").header("Cache-Control", "no-store").send(png);
  });

  app.post<{ Params: { id: string } }>("/checkout/:id/slip", async (req) => {
    const file = await req.file({ limits: { fileSize: MAX_SLIP_BYTES, files: 1 } });
    if (!file) throw new PaymentError(400, "invalid_file", "No slip file uploaded");
    const data = await file.toBuffer();
    if (file.file.truncated) throw new PaymentError(413, "file_too_large", "Slip must be 5 MB or smaller");
    if (!looksLike(file.mimetype, data)) throw new PaymentError(400, "invalid_file", "File content does not match its type");
    const p = payments.attachSlip(req.params.id, file.mimetype, data);
    return { id: p.id, status: p.status };
  });

  app.post<{ Params: { id: string } }>("/checkout/:id/card", async (req) => {
    const { token } = cardChargeSchema.parse(req.body);
    const { payment, authorizeUri } = await payments.chargeCard(req.params.id, token);
    return {
      id: payment.id,
      status: payment.status,
      failure_reason: payment.status === "pending" ? payment.failure_reason : null,
      authorize_uri: authorizeUri ?? null,
    };
  });

  app.get<{ Params: { id: string } }>("/checkout/:id/card-return", async (req, reply) => {
    const p = await payments.refreshCard(req.params.id);
    return reply.redirect(`/checkout/${encodeURIComponent(p.id)}`);
  });
}

/** Checks magic bytes so a renamed executable cannot be stored as a "slip". */
function looksLike(mime: string, data: Buffer): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  switch (mime) {
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47);
    case "image/webp":
      return data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP";
    case "application/pdf":
      return data.subarray(0, 5).toString("latin1") === "%PDF-";
    default:
      return false;
  }
}
