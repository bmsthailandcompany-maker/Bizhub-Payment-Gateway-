import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import type { AuditService } from "../services/audit.ts";
import { parseBaht } from "../services/bank.ts";
import type { MerchantRow, MerchantService } from "../services/merchants.ts";
import { PaymentError, type PaymentService } from "../services/payments.ts";
import { LoginLimiter } from "../services/sessions.ts";
import type { SlipService } from "../services/slips.ts";
import { looksLike, MAX_SLIP_BYTES } from "./checkout.ts";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The shop's standing "I have paid" page, for customers who transfer to the account number
 * as before. They enter the amount and their bill number, attach the slip, and the gateway
 * verifies it and records the payment for staff, with no per-bill link needed.
 */
export async function noticeRoutes(
  app: FastifyInstance,
  opts: { merchants: MerchantService; payments: PaymentService; slips: SlipService; audit: AuditService; publicBaseUrl: string },
) {
  const { merchants, payments, slips } = opts;
  // Each submission can cost slip-verification quota, so cap it per visitor and shop.
  const limiter = new LoginLimiter(10, 60 * 60_000);

  const open = (id: string): MerchantRow => {
    const m = merchants.get(id);
    if (!m || m.active !== 1 || m.notice_enabled !== 1 || (!m.bank_account_no && !m.promptpay_id)) {
      throw new PaymentError(404, "not_found", "ไม่พบหน้าแจ้งชำระเงินนี้");
    }
    return m;
  };

  app.get<{ Params: { id: string } }>("/notice/:id", async (req, reply) => {
    let m: MerchantRow;
    try {
      m = open(req.params.id);
    } catch {
      return reply.code(404).type("text/html; charset=utf-8").send("<!doctype html><meta charset=utf-8><p>ไม่พบหน้าแจ้งชำระเงินนี้</p>");
    }
    const nonce = crypto.randomBytes(16).toString("base64");
    return reply
      .type("text/html; charset=utf-8")
      .header(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      )
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .send(renderNoticePage(m, nonce));
  });

  // QR that opens this page, for printing on bills or pinning in a LINE chat.
  app.get<{ Params: { id: string } }>("/notice/:id/qr.png", async (req, reply) => {
    const m = open(req.params.id);
    const png = await QRCode.toBuffer(`${opts.publicBaseUrl}/notice/${m.id}`, { type: "png", width: 480, margin: 1 });
    return reply.type("image/png").header("Cache-Control", "public, max-age=3600").send(png);
  });

  app.post<{ Params: { id: string } }>("/notice/:id", async (req) => {
    const m = open(req.params.id);
    const key = `${req.ip}|${m.id}`;
    if (limiter.blocked(key)) throw new PaymentError(429, "too_many_attempts", "ส่งหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่ หรือติดต่อร้าน");
    limiter.fail(key);

    let amountRaw = "";
    let reference = "";
    let slip: { mime: string; data: Buffer; truncated: boolean } | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_SLIP_BYTES, files: 1, fields: 5 } })) {
      if (part.type === "file") {
        const data = await part.toBuffer();
        slip = { mime: part.mimetype, data, truncated: part.file.truncated };
      } else if (part.fieldname === "amount") {
        amountRaw = String(part.value ?? "");
      } else if (part.fieldname === "reference") {
        reference = String(part.value ?? "").trim().slice(0, 100);
      }
    }
    const amount = parseBaht(amountRaw);
    if (amount === null || amount < 100 || amount > 200_000_000) throw new PaymentError(400, "invalid_amount", "กรุณากรอกยอดที่โอน เช่น 1250 หรือ 1250.50");
    if (!reference) throw new PaymentError(400, "invalid_reference", "กรุณากรอกเลขที่บิลหรือชื่อผู้สั่งซื้อ");
    if (!slip) throw new PaymentError(400, "invalid_file", "กรุณาแนบสลิป");
    if (slip.truncated) throw new PaymentError(413, "file_too_large", "ไฟล์สลิปต้องไม่เกิน 5 MB");
    if (!looksLike(slip.mime, slip.data)) throw new PaymentError(400, "invalid_file", "ไฟล์ต้องเป็นรูปสลิป (JPG, PNG, WebP) หรือ PDF");

    const payment = payments.create(m, true, {
      amount,
      currency: "THB",
      method: m.bank_account_no ? "bank_transfer" : "promptpay",
      reference,
      description: "แจ้งชำระเงินผ่านหน้าแจ้งโอน",
      metadata: { source: "notice_page" },
    });
    const { payment: after, result } = await slips.submit(payment.id, slip.mime, slip.data);
    // A slip the bank refused should not linger as an unpaid bill in the shop's list.
    if (result.outcome === "rejected" && after.status === "pending") {
      payments.transition(after.id, "cancelled", { failure_reason: result.reason ?? "slip_rejected" });
    }
    return { status: result.outcome === "rejected" ? "rejected" : after.status, verification: result, reference };
  });
}

function renderNoticePage(m: MerchantRow, nonce: string): string {
  const account = m.bank_account_no
    ? `<dl><dt>ธนาคาร</dt><dd>${esc(m.bank_name ?? "-")}</dd><dt>เลขที่บัญชี</dt><dd class="mono">${esc(m.bank_account_no)}</dd><dt>ชื่อบัญชี</dt><dd>${esc(m.bank_account_name ?? "-")}</dd></dl>`
    : `<dl><dt>พร้อมเพย์</dt><dd class="mono">${esc(m.promptpay_id ?? "")}</dd></dl>`;
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>แจ้งชำระเงิน · ${esc(m.name)}</title>
<style nonce="${nonce}">
  :root { --bg:#f5f6f8; --fg:#1d2330; --muted:#667085; --card:#fff; --line:#e4e7ec; --accent:#1a56db; --ok:#067647; --ok-bg:#e7f6ec; --bad:#b42318; --bad-bg:#fdecea; --warn:#b54708; --warn-bg:#fef3e2; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1218; --fg:#e8eaf0; --muted:#98a2b3; --card:#181c24; --line:#2a303c; --accent:#7aa2ff; --ok:#47cd89; --ok-bg:#12291d; --bad:#f97066; --bad-bg:#331816; --warn:#fdb022; --warn-bg:#2e2410; } }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, "Noto Sans Thai", sans-serif; }
  main { max-width:460px; margin:24px auto; padding:0 16px; display:grid; gap:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; display:grid; gap:12px; }
  h1 { font-size:20px; margin:0; } h2 { font-size:15px; margin:0; color:var(--muted); font-weight:600; } p { margin:0; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; margin:0; } dt { color:var(--muted); } dd { margin:0; } .mono { font-family:ui-monospace, monospace; }
  label { display:grid; gap:6px; font-size:14px; color:var(--muted); }
  input { font:inherit; padding:11px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); width:100%; }
  button { font:inherit; font-weight:600; padding:12px; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
  button:disabled { opacity:.6; cursor:wait; }
  .result { border-radius:10px; padding:14px; } .ok { background:var(--ok-bg); color:var(--ok); } .bad { background:var(--bad-bg); color:var(--bad); } .wait { background:var(--warn-bg); color:var(--warn); }
  .small { font-size:13px; color:var(--muted); } [hidden] { display:none !important; }
</style></head>
<body><main>
  <div class="card"><h2>${esc(m.name)}</h2><h1>แจ้งชำระเงิน</h1>
    <p class="small">โอนเงินเข้าบัญชีด้านล่างแล้ว กรอกข้อมูลและแนบสลิป ระบบจะตรวจสอบกับธนาคารให้อัตโนมัติ</p>${account}</div>
  <form class="card" id="f">
    <label for="amount">ยอดที่โอน (บาท)<input id="amount" name="amount" inputmode="decimal" placeholder="เช่น 1250.00" required></label>
    <label for="reference">เลขที่บิล / ชื่อผู้สั่งซื้อ<input id="reference" name="reference" maxlength="100" placeholder="เช่น INV-1024 หรือ คุณสมใจ" required></label>
    <label for="slip">สลิปการโอน<input id="slip" name="slip" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required></label>
    <button type="submit" id="btn">ส่งแจ้งชำระเงิน</button>
    <div id="out" class="result" role="status" hidden></div>
  </form>
  <p class="small">ข้อมูลในสลิปใช้เพื่อยืนยันการชำระเงินกับ ${esc(m.name)} เท่านั้น</p>
</main>
<script nonce="${nonce}">
(() => {
  const REASON = { amount_too_low: "ยอดในสลิปน้อยกว่ายอดที่กรอก", receiver_mismatch: "บัญชีผู้รับในสลิปไม่ใช่บัญชีของร้านนี้",
    slip_older_than_payment: "สลิปนี้เป็นรายการเก่า", duplicate_slip: "สลิปนี้เคยใช้แจ้งชำระแล้ว", transfer_not_found: "ไม่พบรายการโอนนี้ที่ธนาคาร",
    qr_not_found: "ไม่พบ QR บนสลิป กรุณาแนบภาพสลิปเต็มใบ", not_a_payment_slip: "ไฟล์นี้ไม่ใช่สลิปโอนเงิน", invalid_image: "ไฟล์ภาพไม่ถูกต้อง" };
  const f = document.getElementById("f"), out = document.getElementById("out"), btn = document.getElementById("btn");
  const show = (cls, text) => { out.className = "result " + cls; out.textContent = text; out.hidden = false; };
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); btn.disabled = true; out.hidden = true;
    try {
      const fd = new FormData();
      fd.append("amount", document.getElementById("amount").value);
      fd.append("reference", document.getElementById("reference").value);
      fd.append("slip", document.getElementById("slip").files[0]);
      const res = await fetch(location.pathname, { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return show("bad", j.error?.message || "ส่งไม่สำเร็จ กรุณาลองใหม่");
      if (j.status === "succeeded") { show("ok", "ได้รับเงินแล้ว ✓ ยืนยันกับธนาคารเรียบร้อย (" + j.reference + ")"); f.reset(); }
      else if (j.status === "rejected") show("bad", "ตรวจสลิปไม่ผ่าน: " + (REASON[j.verification?.reason] || "กรุณาตรวจสอบสลิปแล้วลองใหม่"));
      else { show("wait", "ได้รับสลิปแล้ว เจ้าหน้าที่จะตรวจสอบและยืนยันให้เร็วที่สุด (" + j.reference + ")"); f.reset(); }
    } catch { show("bad", "เชื่อมต่อไม่ได้ กรุณาลองใหม่"); } finally { btn.disabled = false; }
  });
})();
</script></body></html>`;
}
