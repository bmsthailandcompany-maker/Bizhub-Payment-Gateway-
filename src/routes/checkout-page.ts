import type { MerchantRow } from "../services/merchants.ts";
import type { PaymentRow } from "../services/payments.ts";
import { slipPrivacyNotice } from "./legal.ts";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function baht(satang: number): string {
  return (satang / 100).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface CheckoutPageOptions {
  payment: PaymentRow;
  merchant: MerchantRow;
  nonce: string;
  omisePublicKey: string | null;
}

export function renderCheckoutPage({ payment: p, merchant: m, nonce, omisePublicKey }: CheckoutPageOptions): string {
  const live = p.livemode === 1;
  const state = {
    id: p.id,
    method: p.method,
    status: p.status,
    expiresAt: p.expires_at,
    returnUrl: p.return_url,
    live,
    omisePublicKey: live ? omisePublicKey : null,
  };

  const slipForm = (prompt: string) => `
    <form id="slip-form" class="card-box">
      <label for="slip">${prompt}</label>
      <input id="slip" name="slip" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required>
      <button type="submit">ส่งสลิปเพื่อยืนยัน</button>
      <p class="small">ระบบตรวจสอบสลิปกับธนาคารอัตโนมัติภายในไม่กี่วินาที</p>
      <p class="small privacy">${slipPrivacyNotice(m)}</p>
    </form>`;

  let methodSection = "";
  if (p.method === "promptpay") {
    methodSection = `
      <section data-when="pending">
        <p class="hint">สแกน QR ด้วยแอปธนาคารใดก็ได้ ยอดเงินจะถูกกรอกให้อัตโนมัติ</p>
        <img class="qr" src="/checkout/${esc(p.id)}/qr.png" alt="PromptPay QR สำหรับชำระ ${baht(p.amount)} บาท" width="280" height="280">
        <p class="small">PromptPay · ${esc(m.name)}</p>
        ${slipForm("โอนแล้ว แนบสลิปเพื่อยืนยันการชำระเงิน")}
      </section>`;
  } else if (p.method === "bank_transfer") {
    methodSection = `
      <section data-when="pending">
        <p class="hint">โอนเงินตามยอดด้านบนมาที่บัญชีนี้ แล้วแนบสลิป</p>
        <dl class="bank">
          <dt>ธนาคาร</dt><dd>${esc(m.bank_name ?? "-")}</dd>
          <dt>เลขที่บัญชี</dt><dd><code id="acct">${esc(m.bank_account_no ?? "-")}</code> <button type="button" id="copy-acct" class="link">คัดลอก</button></dd>
          <dt>ชื่อบัญชี</dt><dd>${esc(m.bank_account_name ?? "-")}</dd>
        </dl>
        ${slipForm("แนบสลิปการโอนเงิน")}
      </section>`;
  } else {
    methodSection = `
      <section data-when="pending">
        <form id="card-form" class="card-box" autocomplete="on">
          ${live ? "" : `<p class="test-note">โหมดทดสอบ: ใช้ 4242 4242 4242 4242 (สำเร็จ) หรือ 4000 0000 0000 0002 (ถูกปฏิเสธ)</p>`}
          <label for="cc-name">ชื่อบนบัตร</label>
          <input id="cc-name" autocomplete="cc-name" required>
          <label for="cc-number">หมายเลขบัตร</label>
          <input id="cc-number" inputmode="numeric" autocomplete="cc-number" required>
          <div class="row">
            <div><label for="cc-exp">หมดอายุ (MM/YY)</label><input id="cc-exp" autocomplete="cc-exp" placeholder="MM/YY" required></div>
            <div><label for="cc-cvc">CVC</label><input id="cc-cvc" inputmode="numeric" autocomplete="cc-csc" required></div>
          </div>
          <button type="submit">ชำระ ${baht(p.amount)} บาท</button>
          <p class="small">ข้อมูลบัตรถูกเข้ารหัสในเบราว์เซอร์และส่งตรงไปยังผู้ให้บริการบัตร</p>
        </form>
      </section>`;
  }

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ชำระเงิน · ${esc(m.name)}</title>
<style nonce="${nonce}">
  :root { --bg:#eff6ff; --fg:#092752; --muted:#61748e; --card:#fff; --line:#dce8f6; --accent:#075dcc; --ok:#067647; --bad:#b42318; --warn:#b54708; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1218; --fg:#e8eaf0; --muted:#98a2b3; --card:#181c24; --line:#2a303c; --accent:#6b9bff; --ok:#47cd89; --bad:#f97066; --warn:#fdb022; } }
  * { box-sizing:border-box; }
  body { margin:0; background:linear-gradient(150deg,#e8f4ff,#f8fbff); color:var(--fg); font:16px/1.5 system-ui, "Noto Sans Thai", sans-serif; }
  main { max-width:490px; margin:30px auto; padding:0 16px; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:22px; padding:26px; box-shadow:0 18px 50px #0b397a16; }
  .merchant { color:var(--muted); font-size:14px; margin:0; }
  .amount { font-size:38px; font-weight:800; color:#074aa9; margin:4px 0 0; }
  .desc { color:var(--muted); margin:4px 0 0; }
  .timer { font-size:14px; color:var(--warn); margin-top:8px; }
  hr { border:0; border-top:1px solid var(--line); margin:20px 0; }
  .qr { display:block; margin:12px auto; background:#fff; padding:10px; border-radius:18px; border:2px solid #e3ecf8; max-width:100%; height:auto; }
  .hint { margin:0 0 8px; } .small { font-size:13px; color:var(--muted); text-align:center; } .privacy { font-size:12px; } .privacy a { color:var(--accent); }
  .card-box { display:flex; flex-direction:column; gap:6px; margin-top:16px; }
  label { font-size:14px; color:var(--muted); }
  input { font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); width:100%; }
  button { font:inherit; font-weight:600; padding:12px; border:0; border-radius:12px; background:linear-gradient(100deg,#0996ee,#0747ae); color:#fff; cursor:pointer; margin-top:8px; }
  button:disabled { opacity:.6; cursor:wait; }
  button.link { background:none; color:var(--accent); padding:0 4px; margin:0; font-weight:500; }
  .row { display:flex; gap:12px; } .row > div { flex:1; display:flex; flex-direction:column; gap:6px; }
  .bank { display:grid; grid-template-columns:auto 1fr; gap:6px 12px; margin:0; } .bank dt { color:var(--muted); } .bank dd { margin:0; }
  .test-note { background:color-mix(in srgb, var(--warn) 12%, transparent); color:var(--warn); padding:8px 10px; border-radius:8px; font-size:13px; margin:0 0 4px; }
  .result { text-align:center; } .result h2 { margin:8px 0; } .ok { color:var(--ok); } .bad { color:var(--bad); }
  .error { color:var(--bad); font-size:14px; min-height:1.2em; margin:8px 0 0; }
  [hidden] { display:none !important; }
  .bizhubpay-brand { display:block; width:min(270px,85%); height:94px; object-fit:contain; margin:0 auto 14px; }
  button:focus-visible,input:focus-visible { outline:2px solid #ff9319; outline-offset:2px; }
  @media(max-width:520px) { main { margin:14px auto; padding:0 12px; } .panel { padding:18px; } .amount { font-size:32px; } }
</style>
</head>
<body>
<main><img class="bizhubpay-brand" src="/assets/bizhubpay-logo.svg" alt="BIZHUB PAY Pay Smart Grow Together">
  <div class="panel">
    <p class="merchant">${esc(m.name)}${live ? "" : " · โหมดทดสอบ"}</p>
    <p class="amount">฿${baht(p.amount)}</p>
    ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
    ${p.reference ? `<p class="desc">อ้างอิง: ${esc(p.reference)}</p>` : ""}
    <p class="timer" id="timer" data-when="pending"></p>
    <hr>
    ${methodSection}
    <p class="error" id="error" role="alert"></p>
    <section class="result" data-when="awaiting_review"><h2>ได้รับสลิปแล้ว</h2><p>กำลังรอยืนยันรายการกับธนาคาร/ร้านค้า หน้านี้จะอัปเดตอัตโนมัติ ไม่ต้องโอนซ้ำ</p></section>
    <section class="result" data-when="succeeded"><h2 class="ok">ชำระเงินสำเร็จ</h2><p id="redirect-note">ขอบคุณที่ใช้บริการ</p></section>
    <section class="result" data-when="failed"><h2 class="bad">การชำระเงินไม่สำเร็จ</h2><p>กรุณาติดต่อร้านค้า</p></section>
    <section class="result" data-when="expired"><h2 class="bad">รายการหมดอายุแล้ว</h2><p>กรุณากลับไปสร้างรายการใหม่ที่ร้านค้า</p></section>
    <section class="result" data-when="cancelled"><h2 class="bad">รายการถูกยกเลิก</h2></section>
  </div>
</main>
<script nonce="${nonce}" id="state" type="application/json">${JSON.stringify(state).replace(/</g, "\\u003c")}</script>
${state.omisePublicKey ? `<script nonce="${nonce}" src="https://cdn.omise.co/omise.js"></script>` : ""}
<script nonce="${nonce}">
(() => {
  const S = JSON.parse(document.getElementById("state").textContent);
  const $ = (id) => document.getElementById(id);
  const errorEl = $("error");
  const showError = (msg) => { errorEl.textContent = msg || ""; };

  function render(status) {
    S.status = status;
    document.querySelectorAll("[data-when]").forEach((el) => { el.hidden = el.dataset.when !== status; });
    if (status !== "pending") showError("");
    if (["succeeded", "failed", "expired", "cancelled"].includes(status) && S.returnUrl) {
      const url = new URL(S.returnUrl);
      url.searchParams.set("payment_id", S.id);
      url.searchParams.set("status", status);
      const note = $("redirect-note");
      if (status === "succeeded" && note) note.textContent = "กำลังพากลับไปยังร้านค้า…";
      setTimeout(() => { location.href = url.toString(); }, 3000);
    }
  }

  async function poll() {
    try {
      const res = await fetch("/checkout/" + S.id + "/status", { cache: "no-store" });
      if (res.ok) { const j = await res.json(); if (j.status !== S.status) render(j.status); }
    } catch {}
    if (S.status === "pending" || S.status === "awaiting_review") setTimeout(poll, 4000);
  }

  function tick() {
    const left = Math.max(0, new Date(S.expiresAt).getTime() - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    const t = $("timer");
    if (t) t.textContent = left > 3600000
      ? "กรุณาชำระภายใน " + new Date(S.expiresAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" })
      : "กรุณาชำระภายใน " + m + ":" + String(s).padStart(2, "0") + " นาที";
    if (left === 0 && S.status === "pending") poll(); else if (S.status === "pending") setTimeout(tick, 1000);
  }

  async function postJson(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || "เกิดข้อผิดพลาด กรุณาลองใหม่");
    return j;
  }

  const REJECTED = {
    amount_too_low: "ยอดเงินในสลิปน้อยกว่ายอดที่ต้องชำระ",
    receiver_mismatch: "บัญชีผู้รับในสลิปไม่ใช่บัญชีของร้านนี้",
    slip_older_than_payment: "สลิปนี้เป็นรายการเก่า กรุณาแนบสลิปของการโอนครั้งนี้",
    duplicate_slip: "สลิปนี้ถูกใช้ชำระไปแล้ว",
    transfer_not_found: "ไม่พบรายการโอนนี้ที่ธนาคาร กรุณาตรวจสอบสลิป",
    qr_not_found: "ไม่พบ QR บนสลิป กรุณาแนบภาพสลิปที่ชัดและไม่ถูกครอป",
    not_a_payment_slip: "ไฟล์นี้ไม่ใช่สลิปโอนเงิน",
    invalid_image: "ไฟล์ภาพไม่ถูกต้อง กรุณาแนบภาพสลิปใหม่",
  };
  const ERRORS = {
    too_many_attempts: "แนบสลิปเกินจำนวนครั้งที่กำหนด กรุณาติดต่อร้านค้า",
    verification_in_progress: "กำลังตรวจสอบสลิปอยู่ กรุณารอสักครู่",
    file_too_large: "ไฟล์ใหญ่เกิน 5 MB",
  };

  const slipForm = $("slip-form");
  if (slipForm) slipForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = slipForm.querySelector("button"); btn.disabled = true; showError("");
    try {
      const fd = new FormData(); fd.append("slip", $("slip").files[0]);
      const res = await fetch("/checkout/" + S.id + "/slip", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(ERRORS[j.error?.code] || j.error?.message || "อัปโหลดไม่สำเร็จ");
      if (j.verification?.outcome === "rejected") throw new Error(REJECTED[j.verification.reason] || "ตรวจสอบสลิปไม่ผ่าน กรุณาลองใหม่");
      render(j.status);
    } catch (err) { showError(err.message); } finally { btn.disabled = false; }
  });

  const copyBtn = $("copy-acct");
  if (copyBtn) copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText($("acct").textContent.replace(/-/g, "")).then(() => { copyBtn.textContent = "คัดลอกแล้ว"; });
  });

  function createToken(card) {
    if (!S.live) {
      const digits = card.number.replace(/\\D/g, "");
      if (digits.length < 12) return Promise.reject(new Error("หมายเลขบัตรไม่ถูกต้อง"));
      return Promise.resolve("tok_test_" + digits.slice(-4));
    }
    return new Promise((resolve, reject) => {
      Omise.setPublicKey(S.omisePublicKey);
      Omise.createToken("card", card, (code, resp) => code === 200 ? resolve(resp.id) : reject(new Error(resp.message)));
    });
  }

  const cardForm = $("card-form");
  if (cardForm) cardForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = cardForm.querySelector("button"); btn.disabled = true; showError("");
    try {
      const [mm, yy] = $("cc-exp").value.split("/").map((x) => x.trim());
      const token = await createToken({
        name: $("cc-name").value, number: $("cc-number").value,
        expiration_month: Number(mm), expiration_year: 2000 + Number(yy), security_code: $("cc-cvc").value,
      });
      const j = await postJson("/checkout/" + S.id + "/card", { token });
      if (j.authorize_uri) { location.href = j.authorize_uri; return; }
      if (j.status === "pending" && j.failure_reason) throw new Error("บัตรถูกปฏิเสธ (" + j.failure_reason + ") กรุณาลองบัตรอื่น");
      render(j.status);
    } catch (err) { showError(err.message); } finally { btn.disabled = false; }
  });

  render(S.status);
  tick();
  poll();
})();
</script>
</body>
</html>`;
}
