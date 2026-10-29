/* Shared UI toolkit for the merchant dashboard and admin console. All data goes in via textContent. */
(() => {
  "use strict";

  // ---------- DOM ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }
  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const kid of kids) el.append(kid);
    return el;
  };

  // ---------- formatting (Thai time everywhere: sales are bucketed by Thai day on the server) ----------
  const TZ = "Asia/Bangkok";
  const baht = (satang) => "฿" + (satang / 100).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const bahtShort = (satang) => {
    const b = satang / 100;
    return b >= 1e6 ? (b / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : b >= 1e3 ? (b / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(b));
  };
  const dt = (iso) => (iso ? new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: TZ }) : "-");
  const dayLabel = (d) => new Date(d + "T12:00:00+07:00").toLocaleDateString("th-TH", { day: "numeric", month: "short", timeZone: TZ });
  const todayISO = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const daysAgoISO = (n) => new Date(Date.now() + 7 * 3600_000 - n * 86400_000).toISOString().slice(0, 10);

  const STATUS = {
    pending: ["◷", "รอชำระ"], awaiting_review: ["!", "รอตรวจสอบ"], succeeded: ["✓", "สำเร็จ"],
    failed: ["✕", "ไม่สำเร็จ"], expired: ["–", "หมดอายุ"], cancelled: ["–", "ยกเลิก"],
  };
  const METHOD = { promptpay: "PromptPay", card: "บัตร", bank_transfer: "โอนเงิน" };
  const REASON = {
    amount_too_low: "ยอดในสลิปน้อยกว่ายอดที่ต้องชำระ", amount_too_high: "ยอดในสลิปมากกว่ายอดที่ต้องชำระ",
    receiver_mismatch: "บัญชีผู้รับไม่ใช่บัญชีของร้าน", receiver_unverifiable: "อ่านบัญชีผู้รับจากสลิปไม่ได้",
    slip_older_than_payment: "สลิปเก่ากว่ารายการ", duplicate_slip: "สลิปนี้เคยใช้ชำระแล้ว",
    transfer_not_found: "ไม่พบรายการโอนที่ธนาคาร (อาจเป็นสลิปปลอม)", qr_not_found: "ไม่พบ QR บนสลิป",
    not_a_payment_slip: "ไม่ใช่สลิปโอนเงิน", invalid_image: "ไฟล์ภาพไม่ถูกต้อง",
    bank_delay: "ธนาคารยังไม่อัปเดตรายการ ระบบจะตรวจซ้ำอัตโนมัติ", bank_unavailable: "ระบบธนาคารขัดข้องชั่วคราว ระบบจะตรวจซ้ำอัตโนมัติ",
    verifier_unreachable: "ติดต่อผู้ให้บริการตรวจสลิปไม่ได้ ระบบจะตรวจซ้ำอัตโนมัติ",
    verifier_not_configured: "ยังไม่ได้เปิดการตรวจสลิปอัตโนมัติ กรุณาตรวจเอง",
    pdf_not_verifiable: "สลิปเป็น PDF ตรวจอัตโนมัติไม่ได้", slip_date_missing: "อ่านวันที่โอนจากสลิปไม่ได้",
    payment_state_changed: "สถานะรายการเปลี่ยนระหว่างตรวจ",
  };
  const VERIFY = { verified: "ตรวจสลิปผ่าน", rejected: "ตรวจสลิปไม่ผ่าน", needs_review: "ต้องตรวจสอบเอง" };
  const reasonText = (r) => (r && (REASON[r] || r)) || "";
  const ACTIONS = {
    "auth.login": "เข้าสู่ระบบ", "auth.login_failed": "เข้าสู่ระบบไม่สำเร็จ", "admin.login": "เข้าสู่ระบบแอดมิน", "admin.login_failed": "เข้าสู่ระบบแอดมินไม่สำเร็จ",
    "payment.create": "สร้างลิงก์ชำระเงิน", "payment.approve": "ยืนยันรับเงิน", "payment.reject": "ปฏิเสธสลิป", "payment.cancel": "ยกเลิกรายการ",
    "payments.export": "ส่งออกรายการ", "user.create": "เพิ่มพนักงาน", "user.update": "แก้ไขพนักงาน", "user.reset_password": "รีเซ็ตรหัสผ่านพนักงาน",
    "user.password_changed": "เปลี่ยนรหัสผ่าน", "merchant.create": "สร้างร้านค้า", "merchant.update": "แก้ไขร้านค้า", "merchant.rotate_keys": "ออก API key ใหม่",
    "merchant.rotate_webhook_secret": "เปลี่ยน webhook secret", "merchant_user.create": "เพิ่มบัญชีร้านค้า", "merchant_user.update": "แก้ไขบัญชีร้านค้า",
    "merchant_user.reset_password": "รีเซ็ตรหัสผ่านบัญชีร้านค้า", "webhook.retry": "ส่ง webhook ซ้ำ", "admin_user.create": "เพิ่มแอดมิน",
    "admin_user.update": "แก้ไขแอดมิน",
    "auth.2fa_failed": "ใส่รหัส 2FA ผิด", "admin.2fa_failed": "แอดมินใส่รหัส 2FA ผิด", "user.2fa_enabled": "เปิดใช้ 2FA", "user.2fa_disabled": "ปิด 2FA",
    "user.2fa_recovery_regenerated": "สร้างรหัสกู้คืนใหม่", "user.2fa_reset": "ล้าง 2FA ของพนักงาน", "admin_user.2fa_enabled": "แอดมินเปิดใช้ 2FA",
    "admin_user.2fa_disabled": "แอดมินปิด 2FA", "admin_user.2fa_recovery_regenerated": "แอดมินสร้างรหัสกู้คืนใหม่", "admin_user.2fa_reset": "ล้าง 2FA ของแอดมิน",
    "merchant_user.2fa_reset": "ล้าง 2FA ของบัญชีร้านค้า", "merchant.security_policy": "เปลี่ยนนโยบายความปลอดภัย", "admin_user.reset_password": "รีเซ็ตรหัสผ่านแอดมิน", "admin_user.password_changed": "แอดมินเปลี่ยนรหัสผ่าน",
  };

  function statusBadge(s) {
    const [icon, label] = STATUS[s] || ["", s];
    return h("span", { class: "status " + s }, h("span", { "aria-hidden": "true" }, icon), label);
  }

  function toast(msg) {
    document.querySelectorAll(".toast").forEach((old) => old.remove());
    const t = h("div", { class: "toast", role: "status" }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  function copyText(value) {
    return navigator.clipboard.writeText(value).then(() => toast("คัดลอกแล้ว"), () => toast("คัดลอกไม่ได้ กรุณาคัดลอกเอง"));
  }

  function copyField(value) {
    return h("div", { class: "copy-field" },
      h("input", { type: "text", readonly: true, value, "aria-label": "ค่าที่คัดลอกได้" }),
      h("button", { class: "btn", type: "button", onclick: () => copyText(value) }, "คัดลอก"));
  }

  // ---------- API ----------
  function makeApi(base, onUnauthorized) {
    async function api(path, opts = {}) {
      const res = await fetch(base + path, {
        method: opts.method || "GET",
        headers: { "X-Requested-With": "bizhub-web", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: "same-origin",
      });
      if (res.status === 401 && !opts.allow401) { onUnauthorized(); throw new Error("กรุณาเข้าสู่ระบบ"); }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(j.error?.message || "เกิดข้อผิดพลาด"); e.code = j.error?.code; throw e; }
      return j;
    }
    /** Fetches a file and hands it to the browser as a download (keeps errors visible as JSON). */
    api.download = async (path) => {
      const res = await fetch(base + path, { credentials: "same-origin", headers: { "X-Requested-With": "bizhub-web" } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error?.message || "ดาวน์โหลดไม่สำเร็จ"); }
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "export";
      const url = URL.createObjectURL(await res.blob());
      const a = h("a", { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };
    api.blobUrl = async (path) => {
      const res = await fetch(base + path, { credentials: "same-origin" });
      if (!res.ok) throw new Error("โหลดไฟล์ไม่ได้");
      const blob = await res.blob();
      return { url: URL.createObjectURL(blob), type: blob.type };
    };
    return api;
  }

  // ---------- overlays ----------
  function overlay(kind, title, onClose) {
    const scrim = h("div", { class: "scrim" });
    const body = h("div", { class: "body" });
    const closeBtn = h("button", { class: "btn sm", type: "button" }, "ปิด");
    const box = h(kind === "drawer" ? "aside" : "div", { class: kind, role: "dialog", "aria-modal": "true", "aria-label": title },
      h("header", {}, h("h2", { class: "m0 flex1" }, title), closeBtn), body);
    const prevFocus = document.activeElement;
    const close = () => {
      scrim.remove(); box.remove(); document.removeEventListener("keydown", onKey);
      onClose && onClose();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    closeBtn.addEventListener("click", close);
    scrim.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.append(scrim, box);
    closeBtn.focus();
    return { body, close };
  }
  const drawer = (title, onClose) => overlay("drawer", title, onClose);
  const modal = (title, onClose) => overlay("modal", title, onClose);

  /** Shows a secret exactly once with a copy button and a clear warning. */
  function showSecret(title, lines, note) {
    const m = modal(title);
    m.body.append(
      ...lines.map(([label, value]) => h("div", {}, h("h3", {}, label), h("div", { class: "secret-box" }, value),
        h("div", { class: "row mt8" }, h("button", { class: "btn sm", type: "button", onclick: () => copyText(value) }, "คัดลอก")))),
      h("div", { class: "notice" }, note || "ระบบจะแสดงข้อมูลนี้ครั้งเดียว กรุณาคัดลอกเก็บไว้ก่อนปิดหน้าต่าง"),
      h("div", { class: "row end" }, h("button", { class: "btn primary", type: "button", onclick: m.close }, "เก็บไว้แล้ว")));
  }

  /** A small form inside a modal. fields: [{name,label,type,options,value,required,placeholder}] */
  function formModal(title, fields, submitLabel, onSubmit) {
    const m = modal(title);
    const err = h("p", { class: "error", role: "alert" });
    const inputs = {};
    const rows = fields.map((f) => {
      let input;
      if (f.type === "select") input = h("select", { name: f.name }, f.options.map(([v, l]) => h("option", { value: v, selected: v === f.value ? true : null }, l)));
      else if (f.type === "checkbox") return h("label", { class: "check" }, (inputs[f.name] = h("input", { type: "checkbox", name: f.name, checked: f.value ? true : null })), f.label);
      else input = h("input", { type: f.type || "text", name: f.name, value: f.value ?? "", required: f.required ? true : null, placeholder: f.placeholder, autocomplete: f.autocomplete || "off", maxlength: f.maxlength });
      inputs[f.name] = input;
      return h("label", { class: "f" }, f.label, input, f.hint ? h("span", { class: "small muted" }, f.hint) : null);
    });
    const btn = h("button", { class: "btn primary", type: "submit" }, submitLabel);
    const form = h("form", { class: "grid", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ""; btn.disabled = true;
      const values = {};
      for (const [k, el] of Object.entries(inputs)) values[k] = el.type === "checkbox" ? el.checked : el.value.trim();
      try { await onSubmit(values, m); } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
    } }, rows, err, h("div", { class: "row end" }, h("button", { class: "btn", type: "button", onclick: m.close }, "ยกเลิก"), btn));
    m.body.append(form);
    const first = form.querySelector("input,select"); if (first) first.focus();
    return m;
  }

  // ---------- login & password ----------
  function loginView(root, { title, subtitle, brandClass, onSubmit, altLabel, altField }) {
    let alt = false;
    const err = h("p", { class: "error", role: "alert" });
    const email = h("input", { type: "email", id: "email", autocomplete: "username", required: true });
    const pw = h("input", { type: "password", id: "password", autocomplete: "current-password", required: true });
    const key = h("input", { type: "password", id: "altkey", autocomplete: "off", placeholder: altField.placeholder });
    const userFields = h("div", { class: "grid" }, h("label", { class: "f", for: "email" }, "อีเมล", email), h("label", { class: "f", for: "password" }, "รหัสผ่าน", pw));
    const altFields = h("div", { class: "grid", hidden: true }, h("label", { class: "f", for: "altkey" }, altField.label, key), h("p", { class: "small" }, altField.hint));
    const toggle = h("button", { class: "link small", type: "button", onclick: () => {
      alt = !alt; userFields.hidden = alt; altFields.hidden = !alt;
      email.required = !alt; pw.required = !alt; key.required = alt;
      toggle.textContent = alt ? "เข้าด้วยอีเมลและรหัสผ่าน" : altLabel;
      (alt ? key : email).focus();
    } }, altLabel);
    const btn = h("button", { class: "btn primary", type: "submit" }, "เข้าสู่ระบบ");
    const form = h("form", { class: "card login", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ""; btn.disabled = true;
      try { await onSubmit(alt ? { [altField.name]: key.value.trim() } : { email: email.value.trim(), password: pw.value }); }
      catch (ex) { err.textContent = ex.message; pw.value = ""; }
      finally { btn.disabled = false; }
    } }, h("h1", { class: "m0 " + (brandClass || "") }, title), h("p", {}, subtitle), userFields, altFields, err, h("div", { class: "row" }, btn, h("span", { class: "spacer" }), toggle));
    root.replaceChildren(h("div", { class: "wrap" }, form));
    email.focus();
  }

  // ---------- two-factor authentication ----------
  /** Second login step: 6-digit code from the app, or a recovery code. */
  function mfaPrompt(root, { api, token, onDone, onBack }) {
    let recovery = false;
    const err = h("p", { class: "error", role: "alert" });
    const input = h("input", { type: "text", id: "otp", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]{6}", required: true, class: "otp" });
    const label = h("span", {}, "รหัส 6 หลักจากแอป Authenticator");
    const toggle = h("button", { class: "link small", type: "button", onclick: () => {
      recovery = !recovery;
      label.textContent = recovery ? "รหัสกู้คืน (เช่น abcd-2345)" : "รหัส 6 หลักจากแอป Authenticator";
      input.value = ""; input.maxLength = recovery ? 20 : 6;
      input.inputMode = recovery ? "text" : "numeric";
      if (recovery) input.removeAttribute("pattern"); else input.setAttribute("pattern", "[0-9]{6}");
      toggle.textContent = recovery ? "ใช้รหัสจากแอปแทน" : "ทำมือถือหาย? ใช้รหัสกู้คืน";
      input.focus();
    } }, "ทำมือถือหาย? ใช้รหัสกู้คืน");
    const btn = h("button", { class: "btn primary", type: "submit" }, "ยืนยัน");
    const form = h("form", { class: "card login", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ""; btn.disabled = true;
      try {
        const r = await api("/login/2fa", { method: "POST", body: { mfa_token: token, code: input.value.trim() }, allow401: true });
        if (r.used_recovery_code) toast("ใช้รหัสกู้คืนไปแล้ว 1 รหัส แนะนำให้สร้างชุดใหม่ในหน้าบัญชี");
        await onDone();
      } catch (ex) {
        if (ex.code === "mfa_expired") { toast(ex.message); return onBack(); }
        err.textContent = ex.message; input.value = ""; input.focus();
      } finally { btn.disabled = false; }
    } },
      h("h1", { class: "m0" }, "ยืนยันตัวตน 2 ชั้น"),
      h("p", {}, "เปิดแอป Authenticator ในมือถือ แล้วกรอกรหัสของบัญชีนี้"),
      h("label", { class: "f", for: "otp" }, label, input), err,
      h("div", { class: "row" }, btn, h("span", { class: "spacer" }), toggle),
      h("button", { class: "link small", type: "button", onclick: onBack }, "← กลับไปหน้าเข้าสู่ระบบ"));
    root.replaceChildren(h("div", { class: "wrap" }, form));
    input.focus();
  }

  function showRecoveryCodes(codes) {
    const m = modal("รหัสกู้คืน");
    const text = codes.join("\n");
    const url = URL.createObjectURL(new Blob(["Bizhub recovery codes\n\n" + text + "\n"], { type: "text/plain" }));
    m.body.append(
      h("p", { class: "m0" }, "ใช้แทนรหัสจากแอปได้รหัสละ 1 ครั้ง เมื่อทำมือถือหายหรือเปลี่ยนเครื่อง เก็บไว้ในที่ปลอดภัย (เช่น พิมพ์เก็บ หรือโปรแกรมจัดการรหัสผ่าน)"),
      h("div", { class: "codes" }, codes.map((c) => h("code", {}, c))),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", onclick: () => copyText(text) }, "คัดลอกทั้งหมด"),
        h("a", { class: "btn", href: url, download: "bizhub-recovery-codes.txt" }, "ดาวน์โหลด .txt")),
      h("div", { class: "notice" }, "ระบบจะแสดงรหัสชุดนี้ครั้งเดียว"),
      h("div", { class: "row end" }, h("button", { class: "btn primary", type: "button", onclick: () => { URL.revokeObjectURL(url); m.close(); } }, "เก็บไว้แล้ว")));
  }

  /** Enrolment: scan the QR, confirm one code, receive recovery codes. Renders into `container`. */
  async function mfaSetup(container, { api, onDone, intro }) {
    container.replaceChildren(h("p", { class: "muted" }, "กำลังเตรียม…"));
    const s = await api("/2fa/setup", { method: "POST", body: {} });
    const err = h("p", { class: "error", role: "alert" });
    const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]{6}", required: true, class: "otp", "aria-label": "รหัส 6 หลัก" });
    const btn = h("button", { class: "btn primary", type: "submit" }, "ยืนยันและเปิดใช้");
    container.replaceChildren(h("form", { class: "grid", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ""; btn.disabled = true;
      try {
        const r = await api("/2fa/confirm", { method: "POST", body: { code: code.value.trim() } });
        showRecoveryCodes(r.recovery_codes);
        toast("เปิดใช้ยืนยันตัวตน 2 ชั้นแล้ว");
        await onDone();
      } catch (ex) { err.textContent = ex.message; code.value = ""; code.focus(); } finally { btn.disabled = false; }
    } },
      intro ? h("p", { class: "m0" }, intro) : null,
      h("ol", { class: "steps" },
        h("li", {}, "ติดตั้งแอป Authenticator ในมือถือ (เช่น Google Authenticator, Microsoft Authenticator)"),
        h("li", {}, "สแกน QR นี้ด้วยแอป", h("img", { class: "qr-out mt8", src: s.qr, alt: "QR สำหรับตั้งค่า 2FA" }),
          h("details", { class: "small mt8" }, h("summary", {}, "สแกนไม่ได้? กรอกรหัสนี้ในแอปแทน"), h("div", { class: "secret-box mt8" }, s.secret.replace(/(.{4})/g, "$1 ").trim()))),
        h("li", {}, "กรอกรหัส 6 หลักที่แอปแสดง", code)),
      err, h("div", { class: "row" }, btn)));
    code.focus();
  }

  /** Card for an account page: shows 2FA status with enable / new codes / disable. */
  async function twoFactorCard(container, { api, onChanged }) {
    const st = await api("/2fa");
    const askCode = (title, submit, onSubmit) => formModal(title, [{ name: "code", label: "รหัส 6 หลักจากแอป หรือรหัสกู้คืน", required: true, autocomplete: "one-time-code" }], submit, onSubmit);
    container.replaceChildren(h("div", { class: "card grid" },
      h("h2", { class: "m0" }, "ยืนยันตัวตน 2 ชั้น (2FA)"),
      st.enabled
        ? h("div", {}, h("span", { class: "status on" }, "✓ เปิดใช้อยู่"), h("p", { class: "small muted" }, `เหลือรหัสกู้คืน ${st.recovery_codes_left} รหัส`))
        : h("div", {}, h("span", { class: "status off" }, "ยังไม่เปิดใช้"), h("p", { class: "small muted" }, "แนะนำให้เปิดใช้ เพื่อให้คนที่รู้รหัสผ่านของคุณก็ยังเข้าบัญชีไม่ได้หากไม่มีมือถือของคุณ")),
      h("div", { class: "actions" },
        !st.enabled ? h("button", { class: "btn primary", type: "button", onclick: () => {
          const m = modal("เปิดใช้ยืนยันตัวตน 2 ชั้น");
          mfaSetup(m.body, { api, onDone: async () => { m.close(); await twoFactorCard(container, { api, onChanged }); onChanged && onChanged(); } }).catch((ex) => m.body.replaceChildren(h("p", { class: "error" }, ex.message)));
        } }, "เปิดใช้ 2FA") : null,
        st.enabled ? h("button", { class: "btn", type: "button", onclick: () => askCode("สร้างรหัสกู้คืนชุดใหม่", "สร้างชุดใหม่", async (v, m) => {
          const r = await api("/2fa/recovery-codes", { method: "POST", body: v }); m.close(); showRecoveryCodes(r.recovery_codes); await twoFactorCard(container, { api, onChanged });
        }) }, "สร้างรหัสกู้คืนชุดใหม่") : null,
        st.enabled && !st.required ? h("button", { class: "btn bad", type: "button", onclick: () => askCode("ปิด 2FA", "ปิด 2FA", async (v, m) => {
          await api("/2fa/disable", { method: "POST", body: v }); m.close(); toast("ปิด 2FA แล้ว"); await twoFactorCard(container, { api, onChanged }); onChanged && onChanged();
        }) }, "ปิด 2FA") : null),
      st.required ? h("p", { class: "small muted m0" }, "นโยบายความปลอดภัยกำหนดให้บัญชีนี้ต้องใช้ 2FA") : null));
  }

  /** Full-page forced enrolment shown when policy requires 2FA. */
  function mfaSetupRequiredView(root, { api, onDone, onLogout, reason }) {
    const box = h("div");
    root.replaceChildren(h("div", { class: "wrap" }, h("div", { class: "card login" },
      h("h1", { class: "m0" }, "ตั้งค่ายืนยันตัวตน 2 ชั้น"), box,
      h("button", { class: "link small", type: "button", onclick: onLogout }, "ออกจากระบบ"))));
    mfaSetup(box, { api, onDone, intro: reason }).catch((ex) => box.replaceChildren(h("p", { class: "error" }, ex.message)));
  }

  function changePasswordView(root, { api, forced, onDone }) {
    const err = h("p", { class: "error", role: "alert" });
    const cur = h("input", { type: "password", autocomplete: "current-password", required: true });
    const next = h("input", { type: "password", autocomplete: "new-password", required: true });
    const again = h("input", { type: "password", autocomplete: "new-password", required: true });
    const btn = h("button", { class: "btn primary", type: "submit" }, "บันทึกรหัสผ่านใหม่");
    const form = h("form", { class: "card login", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = "";
      if (next.value !== again.value) { err.textContent = "รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน"; return; }
      btn.disabled = true;
      try { await api("/password", { method: "POST", body: { current_password: cur.value, new_password: next.value } }); toast("เปลี่ยนรหัสผ่านแล้ว"); onDone(); }
      catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
    } },
      h("h1", { class: "m0" }, forced ? "ตั้งรหัสผ่านใหม่" : "เปลี่ยนรหัสผ่าน"),
      forced ? h("p", {}, "นี่เป็นการเข้าใช้ครั้งแรกด้วยรหัสผ่านชั่วคราว กรุณาตั้งรหัสผ่านของคุณเองก่อนใช้งาน") : null,
      h("label", { class: "f" }, forced ? "รหัสผ่านชั่วคราว" : "รหัสผ่านปัจจุบัน", cur),
      h("label", { class: "f" }, "รหัสผ่านใหม่", next, h("span", { class: "small muted" }, "อย่างน้อย 10 ตัวอักษร มีทั้งตัวอักษรและตัวเลข")),
      h("label", { class: "f" }, "ยืนยันรหัสผ่านใหม่", again),
      err, h("div", { class: "row" }, btn));
    root.replaceChildren(h("div", { class: "wrap" }, form));
    cur.focus();
  }

  // ---------- shell ----------
  function shell(root, { brand, brandClass, subtitle, pills, tabs, current, onTab, user, onLogout, extra }) {
    const nav = h("nav", { class: "tabs", "aria-label": "เมนู" }, tabs.map((t) =>
      h("button", { type: "button", "aria-current": current === t.id ? "page" : null, onclick: () => onTab(t.id) },
        t.label, t.badge ? h("span", { class: "badge-count" }, t.badge) : null)));
    const top = h("header", { class: "top" }, h("div", { class: "wrap" },
      h("div", { class: "bar" },
        h("span", { class: "brand " + (brandClass || "") }, brand),
        subtitle ? h("span", { class: "shop" }, subtitle) : null,
        pills,
        h("span", { class: "spacer" }),
        extra || null,
        user ? h("span", { class: "who" }, h("b", {}, user.name), user.role_label) : null,
        h("button", { class: "btn sm", type: "button", onclick: onLogout }, "ออกจากระบบ")),
      nav));
    const main = h("main", { class: "wrap" });
    root.replaceChildren(top, main);
    return main;
  }

  // ---------- chart: daily sales, single series, rounded data-ends, hover tooltip, table fallback ----------
  function salesChart(daily, title) {
    const wrap = h("div", { class: "chart" });
    const tip = h("div", { class: "tooltip", hidden: true });
    const niceStep = (raw) => { const mag = Math.pow(10, Math.floor(Math.log10(raw))); return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((v) => v >= raw); };
    const max = Math.max(...daily.map((d) => d.amount), 0);
    const step = niceStep(Math.max(max, 40000) / 4);
    const top = step * 4;
    const draw = () => {
      const W = Math.max(280, wrap.clientWidth), H = 220, padL = 48, padB = 24, padT = 8;
      const plotW = W - padL, plotH = H - padB - padT;
      const colW = plotW / daily.length, bw = Math.max(4, Math.min(40, colW - 4));
      const y = (v) => padT + plotH - (v / top) * plotH;
      const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${title} ${daily.length} วัน` });
      for (let i = 0; i <= 4; i++) {
        const yy = y(step * i);
        chart.append(svg("line", { class: "gridline", x1: padL, x2: W, y1: yy, y2: yy }));
        const t = svg("text", { class: "axis", x: padL - 8, y: yy + 4, "text-anchor": "end" }); t.textContent = bahtShort(step * i); chart.append(t);
      }
      const labelEvery = Math.ceil(daily.length / Math.max(2, Math.floor(plotW / 64)));
      daily.forEach((d, i) => {
        const x = padL + i * colW + (colW - bw) / 2;
        const col = svg("g", { class: "col", tabindex: "0", "aria-label": `${dayLabel(d.date)} ${baht(d.amount)} ${d.count} รายการ` });
        col.append(svg("rect", { class: "hit", x: padL + i * colW, y: padT, width: colW, height: plotH }));
        if (d.amount > 0) {
          const yt = y(d.amount), yb = y(0), r = Math.min(4, bw / 2, yb - yt);
          col.append(svg("path", { class: "bar", d: `M${x},${yb}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${yb}Z` }));
        }
        if ((daily.length - 1 - i) % labelEvery === 0) {
          const t = svg("text", { class: "axis", x: padL + i * colW + colW / 2, y: H - 6, "text-anchor": "middle" });
          t.textContent = i === daily.length - 1 ? "วันนี้" : dayLabel(d.date); chart.append(t);
        }
        const show = () => {
          tip.replaceChildren(dayLabel(d.date) + " · ", h("b", {}, baht(d.amount)), ` · ${d.count} รายการ`);
          tip.style.left = Math.min(W - 70, Math.max(70, padL + i * colW + colW / 2)) + "px";
          tip.style.top = y(d.amount) + "px";
          tip.hidden = false;
        };
        col.addEventListener("mouseenter", show); col.addEventListener("focus", show);
        col.addEventListener("mouseleave", () => (tip.hidden = true)); col.addEventListener("blur", () => (tip.hidden = true));
        chart.append(col);
      });
      wrap.replaceChildren(chart, tip);
    };
    let lastW = 0;
    new ResizeObserver(() => { if (wrap.clientWidth && wrap.clientWidth !== lastW) { lastW = wrap.clientWidth; draw(); } }).observe(wrap);
    const table = h("table", { class: "list", hidden: true },
      h("thead", {}, h("tr", {}, h("th", {}, "วันที่"), h("th", { class: "num" }, "รายการ"), h("th", { class: "num" }, "ยอดขาย"))),
      h("tbody", {}, daily.slice().reverse().map((d) => h("tr", {}, h("td", {}, dayLabel(d.date)), h("td", { class: "num" }, d.count), h("td", { class: "num" }, baht(d.amount))))));
    const toggle = h("button", { class: "link", type: "button", onclick: () => {
      const showTable = table.hidden; table.hidden = !showTable; wrap.hidden = showTable; toggle.textContent = showTable ? "ดูเป็นกราฟ" : "ดูเป็นตาราง";
    } }, "ดูเป็นตาราง");
    return h("div", { class: "card" }, h("div", { class: "chart-head" }, h("h2", {}, title), toggle), wrap, table);
  }

  // ---------- payments ----------
  function paymentTable(rows, { onOpen, showMerchant }) {
    return h("div", { class: "table-wrap" }, h("table", { class: "list responsive" },
      h("thead", {}, h("tr", {}, h("th", {}, "รายการ"), showMerchant ? h("th", {}, "ร้านค้า") : null, h("th", {}, "ช่องทาง"), h("th", {}, "วันที่"), h("th", {}, "สถานะ"), h("th", { class: "num" }, "ยอดเงิน"))),
      h("tbody", {}, rows.map((p) => h("tr", { class: "click", tabindex: "0", onclick: () => onOpen(p.id), onkeydown: (e) => { if (e.key === "Enter") onOpen(p.id); } },
        h("td", { class: "c-ref" }, h("span", { class: "ref" }, p.reference || p.description || p.id), h("span", { class: "small muted" }, p.reference && p.description ? p.description : "")),
        showMerchant ? h("td", { class: "c-hide small" }, p.merchant_name || p.merchant_id) : null,
        h("td", { class: "c-hide" }, METHOD[p.method]),
        h("td", { class: "c-date small" }, dt(p.created_at)),
        h("td", { class: "c-status" }, statusBadge(p.status)),
        h("td", { class: "num c-amount" }, baht(p.amount)))))));
  }

  /** Payment detail drawer. caps: {review, cancel}; onChange runs after an action succeeds. */
  function openPayment(api, id, { caps, onChange, showMerchant }) {
    let slipUrl = null;
    const d = drawer("รายละเอียดรายการ", () => { if (slipUrl) URL.revokeObjectURL(slipUrl); });
    const path = "/payments/" + encodeURIComponent(id);
    const render = async () => {
      const p = await api(path);
      const kids = [h("div", {}, h("div", { class: "amount-lg" }, baht(p.amount)),
        h("div", { class: "row mt8" }, statusBadge(p.status), h("span", { class: "muted small" }, METHOD[p.method]), p.livemode ? null : h("span", { class: "pill test" }, "ทดสอบ")))];
      if (p.slip_verification) {
        const v = p.slip_verification;
        kids.push(h("div", { class: "verify " + v.status }, h("strong", {}, VERIFY[v.status] || v.status),
          v.reason ? h("span", {}, reasonText(v.reason)) : null,
          v.trans_ref ? h("div", { class: "small muted" }, "เลขอ้างอิงธนาคาร: " + v.trans_ref) : null,
          v.next_retry_at && p.status === "awaiting_review" ? h("div", { class: "small muted" }, "ตรวจซ้ำอัตโนมัติ " + dt(v.next_retry_at)) : null));
      }
      const act = (label, cls, action, getBody) => h("button", { class: "btn " + cls, type: "button", onclick: async (e) => {
        const body = getBody(); if (!body) return;
        e.currentTarget.disabled = true;
        try { await api(path + "/" + action, { method: "POST", body }); toast("บันทึกแล้ว"); await render(); onChange && onChange(); }
        catch (ex) { toast(ex.message); e.currentTarget.disabled = false; }
      } }, label);
      const actions = [];
      if (caps.review && p.method !== "card" && (p.status === "awaiting_review" || p.status === "pending")) {
        actions.push(act("ยืนยันว่าได้รับเงินแล้ว", "good", "approve", () => (confirm(`ยืนยันว่าได้รับเงิน ${baht(p.amount)} เข้าบัญชีแล้ว?`) ? {} : null)));
      }
      if (caps.review && p.status === "awaiting_review") {
        actions.push(act("ปฏิเสธสลิป", "bad", "reject", () => { const r = prompt("เหตุผลที่ปฏิเสธ (ลูกค้าและระบบของร้านจะเห็น)", "ไม่พบยอดเงินเข้า"); return r === null ? null : { reason: r.slice(0, 255) || "rejected" }; }));
      }
      if (caps.cancel && p.status === "pending") actions.push(act("ยกเลิกรายการ", "bad", "cancel", () => (confirm("ยกเลิกรายการนี้? ลูกค้าจะชำระไม่ได้อีก") ? {} : null)));
      if (actions.length) kids.push(h("div", { class: "actions" }, actions));
      kids.push(h("dl", { class: "kv" },
        showMerchant ? [h("dt", {}, "ร้านค้า"), h("dd", {}, p.merchant_name || p.merchant_id)] : null,
        h("dt", {}, "รหัสรายการ"), h("dd", { class: "mono" }, p.id),
        h("dt", {}, "เลขอ้างอิง"), h("dd", {}, p.reference || "-"),
        h("dt", {}, "รายละเอียด"), h("dd", {}, p.description || "-"),
        h("dt", {}, "สร้างเมื่อ"), h("dd", {}, dt(p.created_at)),
        h("dt", {}, p.status === "succeeded" ? "ชำระเมื่อ" : "หมดอายุ"), h("dd", {}, dt(p.status === "succeeded" ? p.paid_at : p.expires_at)),
        p.failure_reason ? [h("dt", {}, "เหตุผล"), h("dd", {}, reasonText(p.failure_reason))] : null));
      if (p.status === "pending") kids.push(h("div", {}, h("h3", {}, "ลิงก์ชำระเงิน"), copyField(p.checkout_url)));
      if (p.has_slip) {
        const slipBox = h("div", {}, h("h3", {}, "สลิป"), h("p", { class: "muted small" }, "กำลังโหลดสลิป…"));
        kids.push(slipBox);
        api.blobUrl(path + "/slip").then(({ url, type }) => {
          if (slipUrl) URL.revokeObjectURL(slipUrl);
          slipUrl = url;
          slipBox.replaceChildren(h("h3", {}, "สลิป"), type === "application/pdf"
            ? h("a", { href: url, target: "_blank", rel: "noopener" }, "เปิดสลิป (PDF)")
            : h("a", { href: url, target: "_blank", rel: "noopener" }, h("img", { class: "slip-img", src: url, alt: "สลิปการโอนเงิน" })));
        }).catch(() => slipBox.replaceChildren(h("h3", {}, "สลิป"), h("p", { class: "error" }, "โหลดสลิปไม่ได้")));
      }
      if (p.slip_checks && p.slip_checks.length) {
        kids.push(h("div", {}, h("h3", {}, "ประวัติการตรวจสลิป"), h("table", { class: "list" },
          h("thead", {}, h("tr", {}, h("th", {}, "เวลา"), h("th", {}, "ผล"), h("th", {}, "รายละเอียด"))),
          h("tbody", {}, p.slip_checks.map((c) => h("tr", {}, h("td", { class: "small" }, dt(c.created_at)), h("td", {}, VERIFY[c.outcome] || c.outcome),
            h("td", { class: "small" }, reasonText(c.reason) || (c.amount != null ? "ยอด " + baht(c.amount) : ""))))))));
      }
      d.body.replaceChildren(...kids);
    };
    d.body.append(h("p", { class: "muted" }, "กำลังโหลด…"));
    render().catch((ex) => d.body.replaceChildren(h("p", { class: "error" }, ex.message)));
  }

  /** Export dialog: date range + status + format, then downloads. extraParams are added to the query. */
  function exportDialog(api, path, extraParams) {
    formModal("ส่งออกรายการชำระเงิน", [
      { name: "from", label: "ตั้งแต่วันที่", type: "date", value: daysAgoISO(29), required: true },
      { name: "to", label: "ถึงวันที่", type: "date", value: todayISO(), required: true },
      { name: "status", label: "สถานะ", type: "select", value: "", options: [["", "ทุกสถานะ"], ...Object.entries(STATUS).map(([k, v]) => [k, v[1]])] },
      { name: "format", label: "รูปแบบไฟล์", type: "select", value: "xlsx", options: [["xlsx", "Excel (.xlsx)"], ["csv", "CSV (.csv)"]] },
    ], "ดาวน์โหลด", async (v, m) => {
      if (v.from > v.to) throw new Error("วันที่เริ่มต้องไม่หลังวันที่สิ้นสุด");
      const params = new URLSearchParams({ format: v.format, from: v.from, to: v.to, ...(extraParams || {}) });
      if (v.status) params.set("status", v.status);
      await api.download(path + "?" + params);
      toast("ดาวน์โหลดแล้ว");
      m.close();
    });
  }

  // ---------- users ----------
  /** Staff/admin account management table. cfg: {api, base, roles, title, canManage, onChanged} */
  async function usersPanel(container, cfg) {
    const { api, base, roles } = cfg;
    const roleOptions = Object.entries(roles).map(([k, v]) => [k, v.label]);
    const load = async (rows) => {
      const users = rows || (await api(base)).data;
      container.replaceChildren(h("div", { class: "card grid" },
        h("div", { class: "page-head m0" }, h("h2", { class: "m0 flex1" }, cfg.title),
          cfg.canManage ? h("button", { class: "btn primary", type: "button", onclick: () => formModal("เพิ่มบัญชี", [
            { name: "name", label: "ชื่อ", required: true, maxlength: 120 },
            { name: "email", label: "อีเมล (ใช้เข้าสู่ระบบ)", type: "email", required: true },
            { name: "role", label: "บทบาท", type: "select", value: roleOptions[roleOptions.length - 1][0], options: roleOptions },
          ], "เพิ่มบัญชี", async (v, m) => {
            const u = await api(base, { method: "POST", body: v });
            m.close(); await load();
            showSecret("ส่งข้อมูลนี้ให้ " + u.name, [["อีเมล", u.email], ["รหัสผ่านชั่วคราว", u.temporary_password]],
              "รหัสผ่านชั่วคราวแสดงครั้งเดียว ผู้ใช้ต้องตั้งรหัสผ่านใหม่ตอนเข้าใช้ครั้งแรก");
            cfg.onChanged && cfg.onChanged();
          }) }, "+ เพิ่มบัญชี") : null),
        users.length ? h("div", { class: "table-wrap" }, h("table", { class: "list" },
          h("thead", {}, h("tr", {}, h("th", {}, "ชื่อ"), h("th", {}, "บทบาท"), h("th", {}, "สถานะ"), h("th", { class: "c-last" }, "เข้าใช้ล่าสุด"), cfg.canManage ? h("th", {}, "") : null)),
          h("tbody", {}, users.map((u) => h("tr", {},
            h("td", {}, h("span", { class: "ref" }, u.name), h("span", { class: "small muted" }, u.email)),
            h("td", {}, h("span", { class: "pill role" }, roles[u.role]?.label || u.role)),
            h("td", {}, u.active ? h("span", { class: "status on" }, "ใช้งาน") : h("span", { class: "status off" }, "ปิดใช้งาน"),
              u.must_change_password && u.active ? h("div", { class: "small muted" }, "ยังไม่ได้ตั้งรหัสผ่าน") : null,
              h("div", { class: "small " + (u.two_factor ? "yes" : "muted") }, u.two_factor ? "✓ 2FA" : "ไม่มี 2FA")),
            h("td", { class: "small c-last" }, u.last_login_at ? dt(u.last_login_at) : "ยังไม่เคยเข้า"),
            cfg.canManage ? h("td", { class: "num" }, h("div", { class: "actions" },
              h("button", { class: "btn sm", type: "button", onclick: () => formModal("แก้ไข " + u.name, [
                { name: "name", label: "ชื่อ", value: u.name, required: true, maxlength: 120 },
                { name: "role", label: "บทบาท", type: "select", value: u.role, options: roleOptions },
                { name: "active", label: "เปิดใช้งานบัญชี", type: "checkbox", value: u.active },
              ], "บันทึก", async (v, m) => { await api(base + "/" + u.id, { method: "PATCH", body: v }); m.close(); toast("บันทึกแล้ว"); await load(); cfg.onChanged && cfg.onChanged(); }) }, "แก้ไข"),
              h("button", { class: "btn sm", type: "button", onclick: async () => {
                if (!confirm(`รีเซ็ตรหัสผ่านของ ${u.name}? ผู้ใช้จะถูกออกจากระบบทุกอุปกรณ์`)) return;
                try { const r = await api(base + "/" + u.id + "/reset-password", { method: "POST", body: {} }); showSecret("รหัสผ่านชั่วคราวใหม่ของ " + u.name, [["รหัสผ่านชั่วคราว", r.temporary_password]]); await load(); }
                catch (ex) { toast(ex.message); }
              } }, "รีเซ็ตรหัสผ่าน"),
              u.two_factor ? h("button", { class: "btn sm", type: "button", onclick: async () => {
                if (!confirm(`ล้าง 2FA ของ ${u.name}? ใช้เมื่อผู้ใช้ทำมือถือหาย ผู้ใช้จะถูกออกจากระบบและต้องตั้งค่า 2FA ใหม่`)) return;
                try { await api(base + "/" + u.id + "/reset-2fa", { method: "POST", body: {} }); toast("ล้าง 2FA แล้ว"); await load(); }
                catch (ex) { toast(ex.message); }
              } }, "ล้าง 2FA") : null)) : null))))) : h("div", { class: "empty" }, "ยังไม่มีบัญชี"),
        roleTable(roles)));
    };
    await load(cfg.rows);
  }

  const PERM_LABEL = {
    "payments.view": "ดูรายการชำระเงิน", "payments.create": "สร้างลิงก์ชำระเงิน", "payments.review": "ยืนยัน/ปฏิเสธสลิป", "payments.cancel": "ยกเลิกรายการ",
    "payments.export": "ส่งออก Excel/CSV", "settings.view": "ดูการตั้งค่า", "webhooks.secret": "ดู webhook secret", "users.manage": "จัดการบัญชีพนักงาน",
    "audit.view": "ดูประวัติการใช้งาน", "merchants.view": "ดูร้านค้า", "merchants.manage": "สร้าง/แก้ไขร้านค้า, ออก key", "merchant_users.manage": "จัดการบัญชีของร้านค้า",
    "webhooks.manage": "ส่ง webhook ซ้ำ", "admins.manage": "จัดการบัญชีแอดมิน",
  };
  function roleTable(roles) {
    const perms = [...new Set(Object.values(roles).flatMap((r) => r.permissions || []))];
    if (!perms.length) return null;
    const details = h("details", {}, h("summary", { class: "small" }, "ดูสิทธิ์ของแต่ละบทบาท"),
      h("div", { class: "table-wrap mt8" }, h("table", { class: "list perm-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "สิทธิ์"), Object.values(roles).map((r) => h("th", {}, r.label)))),
        h("tbody", {}, perms.map((p) => h("tr", {}, h("td", {}, PERM_LABEL[p] || p),
          Object.values(roles).map((r) => h("td", {}, (r.permissions || []).includes(p) ? h("span", { class: "yes", "aria-label": "มีสิทธิ์" }, "✓") : h("span", { class: "no", "aria-label": "ไม่มีสิทธิ์" }, "–")))))))));
    return details;
  }

  function auditTable(rows, { showMerchant }) {
    if (!rows.length) return h("div", { class: "empty" }, "ยังไม่มีประวัติ");
    const detail = (r) => {
      const d = r.details || {};
      if (d.amount != null) return baht(d.amount);
      if (d.email) return d.email + (d.role ? " · " + d.role : "");
      if (d.reason) return reasonText(d.reason);
      if (d.rows != null) return `${d.rows} รายการ (${d.format || ""})`;
      if (d.name) return d.name;
      return "";
    };
    return h("div", { class: "table-wrap" }, h("table", { class: "list" },
      h("thead", {}, h("tr", {}, h("th", {}, "เวลา"), h("th", {}, "ผู้ทำรายการ"), showMerchant ? h("th", {}, "ร้านค้า") : null, h("th", {}, "การกระทำ"), h("th", {}, "รายละเอียด"), h("th", {}, "IP"))),
      h("tbody", {}, rows.map((r) => h("tr", {},
        h("td", { class: "small" }, dt(r.created_at)),
        h("td", {}, r.actor_name),
        showMerchant ? h("td", { class: "small" }, r.merchant_name || "-") : null,
        h("td", {}, ACTIONS[r.action] || r.action, r.target ? h("div", { class: "small muted mono" }, r.target) : null),
        h("td", { class: "small" }, detail(r)),
        h("td", { class: "small muted mono" }, r.ip || ""))))));
  }

  window.UI = {
    h, svg, baht, bahtShort, dt, dayLabel, STATUS, METHOD, statusBadge, toast, copyText, copyField, makeApi,
    drawer, modal, showSecret, formModal, loginView, changePasswordView, shell, salesChart, paymentTable, openPayment,
    mfaPrompt, mfaSetupRequiredView, twoFactorCard, showRecoveryCodes,
    exportDialog, usersPanel, auditTable, reasonText,
  };
})();
