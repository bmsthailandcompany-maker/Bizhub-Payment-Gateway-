/* Self sign-up for new shops. The owner lands in the dashboard in test mode and finishes verification there. */
(() => {
  "use strict";
  const { h } = UI;
  const root = document.getElementById("app");
  const field = (id, label, attrs, hint) => h("label", { class: "f", for: id }, label, h("input", { id, name: id, ...attrs }), hint ? h("span", { class: "small muted" }, hint) : null);
  const err = h("p", { class: "error", role: "alert" });
  const btn = h("button", { class: "btn primary", type: "submit" }, "สมัครและเริ่มทดลองใช้");
  const terms = h("input", { type: "checkbox", id: "terms", required: true });
  const form = h("form", { class: "card login", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    const v = (id) => document.getElementById(id).value.trim();
    if (v("password") !== document.getElementById("password2").value.trim()) { err.textContent = "รหัสผ่านทั้งสองช่องไม่ตรงกัน"; return; }
    btn.disabled = true;
    try {
      const res = await fetch("/signup/api", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "bizhub-web" },
        body: JSON.stringify({ business_name: v("business"), contact_name: v("contact"), email: v("email"), phone: v("phone"), password: document.getElementById("password").value, accept_terms: terms.checked }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error?.details?.[0]?.message || j.error?.message || "สมัครไม่สำเร็จ");
      location.href = "/dashboard";
    } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  } },
    h("h1", { class: "m0" }, "สมัครร้านค้า BIZHUB PAY"),
    h("p", {}, "สมัครและเริ่มใช้งาน Dashboard ได้ทันทีโดยไม่จำกัดอายุร้านค้า • สร้างรายการและลิงก์ชำระเงินในโหมดทดสอบ • เปิดยืนยันเงินเข้าอัตโนมัติเมื่อผ่านการตรวจสอบและเชื่อมต่อผู้ให้บริการที่รองรับ"),
    field("business", "ชื่อร้าน / ชื่อธุรกิจ", { type: "text", required: true, maxlength: "120", autocomplete: "organization" }),
    field("contact", "ชื่อผู้ติดต่อ", { type: "text", required: true, maxlength: "120", autocomplete: "name" }),
    field("email", "อีเมล (ใช้เข้าสู่ระบบ)", { type: "email", required: true, autocomplete: "email" }),
    field("phone", "เบอร์โทร", { type: "tel", required: true, autocomplete: "tel", placeholder: "0812345678" }),
    field("password", "รหัสผ่าน", { type: "password", required: true, autocomplete: "new-password" }, "ตั้งรหัสผ่านที่คาดเดายากตามข้อกำหนดความปลอดภัย"),
    field("password2", "ยืนยันรหัสผ่าน", { type: "password", required: true, autocomplete: "new-password" }),
    h("label", { class: "check" }, terms, h("span", {}, "ยอมรับเงื่อนไขการใช้บริการ และ ", h("a", { href: "/privacy", target: "_blank", rel: "noopener" }, "นโยบายความเป็นส่วนตัว"))),
    err, h("div", { class: "row" }, btn, h("span", { class: "spacer" }), h("a", { class: "small", href: "/dashboard" }, "มีบัญชีอยู่แล้ว? เข้าสู่ระบบ")));
  root.replaceChildren(h("div", { class: "wrap" }, form));
})();
