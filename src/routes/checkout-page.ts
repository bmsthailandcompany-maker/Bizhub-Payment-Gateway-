import type { MerchantRow } from "../services/merchants.ts";
import type { PaymentRow } from "../services/payments.ts";

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

  const slipForm = (required: boolean) => `
    <form id="slip-form" class="card-box">
      <label for="slip">${required ? "แนบสลิปการโอนเงิน" : "โอนแล้ว? แนบสลิปเพื่อให้ร้านค้ายืนยันเร็วขึ้น"}</label>
      <input id="slip" name="slip" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required>
      <button type="submit">ส่งสลิป</button>
    </form>`;

  let methodSection = "";
  if (p.method === "promptpay") {
    methodSection = `
      <section data-when="pending">
        <p class="hint">สแกน QR ด้วยแอปธนาคารใดก็ได้ ยอดเงินจะถูกกรอกให้อัตโนมัติ</p>
        <img class="qr" src="/checkout/${esc(p.id)}/qr.png" alt="PromptPay QR สำหรับชำระ ${baht(p.amount)} บาท" width="280" height="280">
        <p class="small">PromptPay · ${esc(m.name)}</p>
        ${slipForm(false)}
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
        ${slipForm(true)}
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
  :root { --bg:#f5f6f8; --fg:#1d2330; --muted:#667085; --card:#fff; --line:#e4e7ec; --accent:#1a56db; --ok:#067647; --bad:#b42318; --warn:#b54708; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1218; --fg:#e8eaf0; --muted:#98a2b3; --card:#181c24; --line:#2a303c; --accent:#6b9bff; --ok:#47cd89; --bad:#f97066; --warn:#fdb022; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, "Noto Sans Thai", sans-serif; }
  main { max-width:440px; margin:24px auto; padding:0 16px; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; }
  .merchant { color:var(--muted); font-size:14px; margin:0; }
  .amount { font-size:34px; font-weight:700; margin:4px 0 0; }
  .desc { color:var(--muted); margin:4px 0 0; }
  .timer { font-size:14px; color:var(--warn); margin-top:8px; }
  hr { border:0; border-top:1px solid var(--line); margin:20px 0; }
  .qr { display:block; margin:12px auto; background:#fff; padding:10px; border-radius:10px; max-width:100%; height:auto; }
  .hint { margin:0 0 8px; } .small { font-size:13px; color:var(--muted); text-align:center; }
  .card-box { display:flex; flex-direction:column; gap:6px; margin-top:16px; }
  label { font-size:14px; color:var(--muted); }
  input { font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); width:100%; }
  button { font:inherit; font-weight:600; padding:12px; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; margin-top:8px; }
  button:disabled { opacity:.6; cursor:wait; }
  button.link { background:none; color:var(--accent); padding:0 4px; margin:0; font-weight:500; }
  .row { display:flex; gap:12px; } .row > div { flex:1; display:flex; flex-direction:column; gap:6px; }
  .bank { display:grid; grid-template-columns:auto 1fr; gap:6px 12px; margin:0; } .bank dt { color:var(--muted); } .bank dd { margin:0; }
  .test-note { background:color-mix(in srgb, var(--warn) 12%, transparent); color:var(--warn); padding:8px 10px; border-radius:8px; font-size:13px; margin:0 0 4px; }
  .result { text-align:center; } .result h2 { margin:8px 0; } .ok { color:var(--ok); } .bad { color:var(--bad); }
  .error { color:var(--bad); font-size:14px; min-height:1.2em; margin:8px 0 0; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <div class="panel">
    <p class="merchant">${esc(m.name)}${live ? "" : " · โหมดทดสอบ"}</p>
    <p class="amount">฿${baht(p.amount)}</p>
    ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
    ${p.reference ? `<p class="desc">อ้างอิง: ${esc(p.reference)}</p>` : ""}
    <p class="timer" id="timer" data-when="pending"></p>
    <hr>
    ${methodSection}
    <p class="error" id="error" role="alert"></p>
    <section class="result" data-when="awaiting_review"><h2>ได้รับสลิปแล้ว</h2><p>ร้านค้ากำลังตรวจสอบการชำระเงิน หน้านี้จะอัปเดตอัตโนมัติ</p></section>
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
    const t = $("timer"); if (t) t.textContent = "กรุณาชำระภายใน " + m + ":" + String(s).padStart(2, "0") + " นาที";
    if (left === 0 && S.status === "pending") poll(); else if (S.status === "pending") setTimeout(tick, 1000);
  }

  async function postJson(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || "เกิดข้อผิดพลาด กรุณาลองใหม่");
    return j;
  }

  const slipForm = $("slip-form");
  if (slipForm) slipForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = slipForm.querySelector("button"); btn.disabled = true; showError("");
    try {
      const fd = new FormData(); fd.append("slip", $("slip").files[0]);
      const res = await fetch("/checkout/" + S.id + "/slip", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error?.message || "อัปโหลดไม่สำเร็จ");
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
