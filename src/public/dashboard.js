/* Merchant dashboard. What each tab shows and which buttons appear follow the signed-in user's permissions. */
(() => {
  "use strict";
  const { h, baht, dt, statusBadge, toast, copyField, makeApi } = UI;
  const root = document.getElementById("app");
  const api = makeApi("/dashboard/api", () => showLogin());
  const S = { me: null, tab: "overview", filter: "", q: "", list: [], hasMore: false, summary: null };
  const can = (p) => S.me && S.me.permissions.includes(p);
  const MFA_REASON = "ร้านนี้กำหนดให้พนักงานทุกคนใช้การยืนยันตัวตน 2 ชั้น กรุณาตั้งค่าให้เสร็จก่อนเริ่มใช้งาน";
  let main;

  function showLogin() {
    S.me = null;
    UI.loginView(root, {
      onSubmit: async (body) => {
        const r = await api("/unified-login",{method:"POST",body,allow401:true});
        if (r.mfa_required) {
          const mfaApi = r.scope === "admin" ? makeApi("/admin/console/api",showLogin) : api;
          return UI.mfaPrompt(root,{api:mfaApi,token:r.mfa_token,onDone:()=>r.scope==="admin" ? window.location.assign("/admin/console") : boot(),onBack:showLogin});
        }
        if (r.scope === "admin") {window.location.assign("/admin/console");return;}
        await boot();
      },
    });
  }

  const TABS = [
    { id: "kyc", label: "เปิดรับเงินจริง", perm: "users.manage", when: () => S.me.merchant.kyc.status !== "approved" },
    { id: "overview", label: "ภาพรวม", perm: "payments.view" },
    { id: "payments", label: "รายการชำระเงิน", perm: "payments.view" },
    { id: "create", label: "สร้างลิงก์ชำระเงิน", perm: "payments.create" },
    { id: "team", label: "พนักงาน", perm: "users.manage" },
    { id: "bank", label: "บัญชีธนาคาร", perm: "settings.view" },
    { id: "billing", label: "ค่าบริการ", perm: "billing.view" },
    { id: "audit", label: "ประวัติการใช้งาน", perm: "audit.view" },
    { id: "settings", label: "ตั้งค่า", perm: null },
  ];

  function renderShell() {
    const m = S.me.merchant;
    const review = S.summary?.awaiting_review || 0;
    const modeSwitch = S.me.livemode ? null :
      h("span",{class:"pill test",role:"status"},"โหมดทดสอบ — ยังไม่ใช่ข้อมูลจริง");
    main = UI.shell(root, {
      brand: "BIZHUB PAY", subtitle: null,
      extra: modeSwitch,
      user: { ...S.me.user, name: S.me.user.name || m.name, role_label: S.me.user.role_label || "บัญชีร้านค้า" },
      tabs: TABS.filter((t) => (!t.perm || can(t.perm)) && (!t.when || t.when())).map((t) => ({ ...t, badge: t.id === "payments" && review ? review : null })),
      current: S.tab,
      onTab: go,
      onProfile: () => go("settings"),
      onLogout: async () => { await api("/logout", { method: "POST" }).catch(() => {}); showLogin(); },
    });
  }

  function go(tab) {
    const visible = (x) => (!x.perm || can(x.perm)) && (!x.when || x.when());
    const t = TABS.find((x) => x.id === tab);
    if (!t || !visible(t)) tab = TABS.find(visible).id;
    S.tab = tab;
    renderShell();
    const views = { overview: viewOverview, payments: viewPayments, create: viewCreate, team: viewTeam, bank: viewBank, kyc: viewKyc, billing: viewBilling, audit: viewAudit, settings: viewSettings };
    Promise.resolve(views[tab]()).catch((ex) => main.replaceChildren(h("p", { class: "error" }, ex.message)));
  }

  const openPayment = (id) => UI.openPayment(api, id, {
    caps: { review: can("payments.review"), cancel: can("payments.cancel") },
    onChange: () => { if (S.tab === "overview") viewOverview(); else if (S.tab === "payments") reloadList(); },
  });

  /** Shown above the overview until the shop passes review. */
  function kycBanner() {
    const k = S.me.merchant.kyc;
    if (k.status === "approved") return null;
    const text = {
      draft: "ร้านอยู่ในโหมดทดสอบ ส่งข้อมูลและเอกสารยืนยันตัวตนร้านเพื่อเปิดรับเงินจริง",
      submitted: "ส่งเอกสารแล้ว ทีมงานกำลังตรวจสอบ ระหว่างนี้ใช้โหมดทดสอบได้ตามปกติ",
      rejected: "เอกสารยังไม่ผ่าน: " + (k.note || "กรุณาตรวจสอบและส่งใหม่"),
    }[k.status];
    return h("div", { class: "notice row" }, h("span", { class: "flex1" }, text),
      can("users.manage") && k.status !== "submitted" ? h("button", { class: "btn sm primary", type: "button", onclick: () => go("kyc") }, k.status === "rejected" ? "แก้ไขและส่งใหม่" : "ยืนยันตัวตนร้าน") : null);
  }

  // ---------- overview ----------
  async function viewOverview() {
    main.replaceChildren(h("h1", {}, "ภาพรวมธุรกิจ"), h("p", { class:"muted" }, "กำลังโหลดข้อมูลธุรกรรม…"));
    const [summary, review, recent] = await Promise.all([
      api("/summary"), api("/payments?status=awaiting_review&limit=5"), api("/payments?limit=5")
    ]);
    const changed = S.summary?.awaiting_review !== summary.awaiting_review;
    S.summary = summary;
    if (changed) renderShell();
    const tile = (label, value, sub, extra={}) => h("div", {class:"card tile"+(extra.attn?" attn":"")},
      h("div",{class:"label"},label),h("div",{class:"value"},value),
      sub?h("div",{class:"sub"},sub):null,extra.action||null);
    const shortcut = (symbol,label,action) => h("button",{type:"button",class:"merchant-shortcut",onclick:action},
      h("span",{class:"shortcut-symbol","aria-hidden":"true"},symbol),h("strong",{},label));
    const quick = h("div",{class:"card merchant-quick"},
      h("h2",{},"⚡ ทำรายการด่วน"),
      h("div",{class:"merchant-quick-grid"},
        can("payments.create")?shortcut("▦","สร้าง QR / ลิงก์รับเงิน",()=>go("create")):null,
        can("payments.view")?shortcut("▤","รายการชำระเงิน",()=>go("payments")):null,
        can("settings.view")?shortcut("▣","บัญชีธนาคาร",()=>go("bank")):null,
        can("payments.export")?shortcut("↧","ส่งออกรายงาน",()=>UI.exportDialog(api,"/payments/export")):null));
    const paid = recent.data.filter(p => p.status === "succeeded");
    const methodCounts = { promptpay:0, card:0, bank_transfer:0 };
    for (const p of paid) if (Object.prototype.hasOwnProperty.call(methodCounts,p.method)) methodCounts[p.method]++;
    const methodTotal = Object.values(methodCounts).reduce((a,b)=>a+b,0);
    const methodPercent = key => methodTotal ? Math.round(methodCounts[key]*100/methodTotal) : 0;
    const methods = [["promptpay","PromptPay"],["card","บัตรเครดิต / เดบิต"],["bank_transfer","โอนเงินผ่านธนาคาร"]];
    const breakdown = h("div",{class:"card merchant-breakdown"},
      h("h2",{},"สัดส่วนช่องทางชำระเงิน (รายการล่าสุด)"),
      h("div",{class:"merchant-breakdown-body"},
        h("div",{class:"merchant-donut",role:"img","aria-label":"สัดส่วนการชำระเงินจากรายการสำเร็จล่าสุด"},
          h("div",{class:"merchant-donut-inner"},h("strong",{},String(methodTotal)),h("span",{},"รายการสำเร็จ"))),
        h("div",{class:"merchant-legend"},methods.map(([key,label])=>
          h("div",{class:"merchant-legend-row"},
            h("span",{class:"merchant-legend-dot "+key}),h("span",{},label),
            h("strong",{},methodPercent(key)+"%"))))));
    const donut = breakdown.querySelector(".merchant-donut");
    const p1 = methodPercent("promptpay"), p2 = methodPercent("card");
    donut.style.background = methodTotal
      ? `conic-gradient(#0876f4 0% ${p1}%,#ff970f ${p1}% ${p1+p2}%,#20c879 ${p1+p2}% 100%)`
      : "conic-gradient(#dce7f5 0% 100%)";
    main.replaceChildren(
      h("div",{class:"page-head merchant-welcome"},
        h("div",{},h("h1",{},"ภาพรวมธุรกิจ"),h("p",{class:"muted m0"},"จัดการรับชำระเงินและติดตามยอดขายของ "+S.me.merchant.name)),
        can("payments.export")?h("button",{class:"btn",type:"button",onclick:()=>UI.exportDialog(api,"/payments/export")},"ส่งออก Excel/CSV"):null),
      ...(() => { const banner = kycBanner(); return banner ? [banner] : []; })(),
      h("div",{class:"grid tiles merchant-kpis"},
        tile("ยอดรับชำระวันนี้",baht(summary.today.amount),summary.today.count+" รายการ"),
        tile("ยอดรับชำระ "+summary.period.days+" วัน",baht(summary.period.amount),summary.period.count+" รายการ"),
        tile("รอตรวจสอบ",String(summary.awaiting_review),"สลิปที่ต้องตรวจด้วยตนเอง",{attn:summary.awaiting_review>0,
          action:summary.awaiting_review>0?h("button",{class:"link",type:"button",onclick:()=>{S.filter="awaiting_review";go("payments");}},"ไปตรวจสอบ →"):null}),
        tile("รอชำระ",String(summary.pending),"รายการที่ยังไม่ชำระ")),
      h("div",{class:"merchant-overview-row"},UI.salesChart(summary.daily,"ยอดรับชำระรายวัน (สำเร็จ)"),quick),
      h("section",{class:"merchant-solutions"},
        h("h2",{},"โซลูชันสำหรับทุกธุรกิจ"),
        h("div",{class:"merchant-solutions-grid"},
          [["🍽","ร้านอาหาร / คาเฟ่","รับชำระหน้าร้าน"],["🛍","ร้านค้า / Retail","ส่งลิงก์ชำระเงิน"],["✈","ธุรกิจทัวร์ / Travel","รับเงินจองและมัดจำ"],["▥","โรงงาน / บริษัท","รับเงินอ้างอิงใบแจ้งหนี้"]].map(([icon,name,desc]) =>
            h("div",{class:"merchant-solution-card"},h("span",{class:"merchant-solution-icon"},icon),h("strong",{},name),h("span",{},desc))))),
      h("div",{class:"merchant-overview-row"},
        h("div",{class:"card merchant-recent"},h("div",{class:"row"},h("h2",{},"รายการธุรกรรมล่าสุด"),h("span",{class:"spacer"}),h("button",{class:"link",type:"button",onclick:()=>go("payments")},"ดูทั้งหมด →")),
          recent.data.length?UI.paymentTable(recent.data,{onOpen:openPayment}):h("div",{class:"empty"},"ยังไม่มีรายการชำระเงิน")),
        breakdown),
      review.data.length ? h("div",{class:"card merchant-recent"},h("h2",{},"รายการที่รอตรวจสอบ"),UI.paymentTable(review.data,{onOpen:openPayment})) : null);
  }

  // ---------- payments ----------
  async function loadPayments(more) {
    const params = new URLSearchParams({ limit: "25" });
    if (S.filter) params.set("status", S.filter);
    if (S.q) params.set("q", S.q);
    if (more && S.list.length) params.set("starting_after", S.list[S.list.length - 1].id);
    const res = await api("/payments?" + params);
    S.list = more ? S.list.concat(res.data) : res.data;
    S.hasMore = res.has_more;
  }
  let listBox;
  function renderList() {
    listBox.replaceChildren(...[
      S.list.length ? UI.paymentTable(S.list, { onOpen: openPayment }) : h("div", { class: "empty" }, "ไม่พบรายการ"),
      S.hasMore ? h("div", { class: "row center mt12" }, h("button", { class: "btn", type: "button", onclick: async () => { await loadPayments(true); renderList(); } }, "โหลดเพิ่ม")) : null,
    ].filter(Boolean));
  }
  async function reloadList() { await loadPayments(false); renderList(); }

  async function viewPayments() {
    const FILTERS = [["", "ทั้งหมด"], ...Object.entries(UI.STATUS).map(([k, v]) => [k, v[1]])];
    listBox = h("div");
    const chips = h("div", { class: "chips", role: "group", "aria-label": "กรองสถานะ" }, FILTERS.map(([v, label]) =>
      h("button", { class: "chip", type: "button", "aria-pressed": String(S.filter === v), onclick: async (e) => {
        S.filter = v; chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget)));
        await reloadList();
      } }, label)));
    let timer;
    const search = h("input", { type: "search", placeholder: "ค้นหาเลขอ้างอิง / รายละเอียด / รหัสรายการ", value: S.q, "aria-label": "ค้นหา",
      oninput: () => { clearTimeout(timer); timer = setTimeout(async () => { S.q = search.value.trim(); await reloadList(); }, 300); } });
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", {}, "รายการชำระเงิน"),
        can("payments.export") ? h("button", { class: "btn", type: "button", onclick: () => UI.exportDialog(api, "/payments/export", S.q ? { q: S.q } : {}) }, "ส่งออก Excel/CSV") : null),
      h("div", { class: "card grid" }, h("div", { class: "grid" }, search, chips), listBox));
    await reloadList();
  }

  // ---------- create payment link ----------
  function viewCreate() {
    const m = S.me.merchant;
    const methods = [m.promptpay_id ? ["promptpay", "PromptPay QR"] : null, m.bank_account ? ["bank_transfer", "โอนเงิน + แนบสลิป"] : null, ["card", "บัตรเครดิต/เดบิต"]].filter(Boolean);
    const amount = h("input", { type: "number", min: "1", step: "0.01", required: true, inputmode: "decimal", placeholder: "0.00" });
    const method = h("select", {}, methods.map(([v, l]) => h("option", { value: v }, l)));
    const desc = h("input", { type: "text", maxlength: "255", placeholder: "เช่น ลาเต้เย็น x2" });
    const ref = h("input", { type: "text", maxlength: "100", placeholder: "เช่น INV-1001 (ไม่บังคับ)" });
    const ttl = h("select", {}, [["900", "15 นาที"], ["3600", "1 ชั่วโมง"], ["86400", "1 วัน"], ["604800", "7 วัน"]].map(([v, l]) => h("option", { value: v }, l)));
    const err = h("p", { class: "error", role: "alert" });
    const out = h("div");
    const btn = h("button", { class: "btn primary", type: "submit" }, "สร้างลิงก์");
    const form = h("form", { class: "card grid", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ""; btn.disabled = true;
      try {
        const p = await api("/payments", { method: "POST", body: {
          amount: Math.round(Number(amount.value) * 100), method: method.value, description: desc.value || undefined, reference: ref.value || undefined, expires_in: Number(ttl.value) } });
        out.replaceChildren(h("div", { class: "card grid" }, h("h2", { class: "m0" }, "ลิงก์พร้อมส่งให้ลูกค้า"),
          h("div", { class: "row" }, h("span", { class: "amount-lg" }, baht(p.amount)), statusBadge(p.status)),
          copyField(p.checkout_url),
          p.promptpay ? h("div", {}, h("p", { class: "small muted" }, "หรือให้ลูกค้าสแกน QR นี้ได้เลย (หมดอายุ " + dt(p.expires_at) + ")"),
            h("img", { class: "qr-out", src: new URL(p.promptpay.qr_image_url).pathname, alt: "PromptPay QR " + baht(p.amount) })) : null,
          h("div", { class: "row" }, h("a", { class: "btn", href: p.checkout_url, target: "_blank", rel: "noopener" }, "เปิดหน้าชำระเงิน"),
            can("payments.view") ? h("button", { class: "btn", type: "button", onclick: () => openPayment(p.id) }, "ดูรายละเอียด") : null)));
        form.reset();
      } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
    } },
      h("p", { class: "muted m0" }, "สร้างลิงก์ชำระเงินส่งให้ลูกค้าทาง LINE / แชต ได้เลยโดยไม่ต้องเชื่อม API" + (S.me.livemode ? "" : " (โหมดทดสอบ)")),
      h("label", { class: "f" }, "ยอดเงิน (บาท)", amount), h("label", { class: "f" }, "ช่องทางชำระ", method),
      h("label", { class: "f" }, "รายละเอียด", desc), h("label", { class: "f" }, "เลขอ้างอิง", ref),
      h("label", { class: "f" }, "ลิงก์หมดอายุใน", ttl), err, h("div", { class: "row" }, btn));
    main.replaceChildren(h("h1", {}, "สร้างลิงก์ชำระเงิน"), h("div", { class: "grid narrow" }, form, out));
  }

  // ---------- team ----------
  async function viewTeam() {
    const box = h("div");
    const policy = h("input", { type: "checkbox", checked: S.me.merchant.require_2fa ? true : null, onchange: async () => {
      const want = policy.checked;
      if (want && !confirm("บังคับให้พนักงานทุกคนใช้ 2FA? คนที่ยังไม่ได้ตั้งค่าจะต้องตั้งค่าก่อนใช้งานครั้งถัดไป")) { policy.checked = false; return; }
      try { await api("/security", { method: "PATCH", body: { require_2fa: want } }); S.me.merchant.require_2fa = want; toast("บันทึกแล้ว"); }
      catch (ex) { policy.checked = !want; toast(ex.message); }
    } });
    main.replaceChildren(h("h1", {}, "พนักงาน"),
      h("div", { class: "grid" },
        h("div", { class: "notice info small" }, "เพิ่มบัญชีให้พนักงานแต่ละคน แล้วเลือกบทบาทตามหน้าที่ ทุกการกระทำจะถูกบันทึกในประวัติการใช้งานพร้อมชื่อผู้ทำ"),
        h("div", { class: "card grid" }, h("h2", { class: "m0" }, "นโยบายความปลอดภัย"),
          h("label", { class: "check" }, policy, "บังคับให้พนักงานทุกคนใช้การยืนยันตัวตน 2 ชั้น (2FA)"),
          h("p", { class: "small muted m0" }, "พนักงานต้องใช้รหัส 6 หลักจากแอป Authenticator ทุกครั้งที่เข้าสู่ระบบ (การเข้าด้วย Secret key ไม่ได้รับผลกระทบ)")),
        box));
    await UI.usersPanel(box, { api, base: "/users", roles: S.me.roles, title: "บัญชีพนักงาน", canManage: true });
  }

  // ---------- audit ----------
  // ---------- linked bank account ----------
  const BANK_OUTCOME = {
    matched: ["on", "ยืนยันรายการแล้ว"], duplicate: ["", "แจ้งซ้ำ (ไม่นับซ้ำ)"], amount_mismatch: ["awaiting_review", "ยอดไม่ตรง ส่งให้ตรวจ"],
    already_paid: ["", "รายการชำระไปแล้ว"], paid_after_close: ["off", "เงินเข้าหลังรายการปิด"], ambiguous: ["awaiting_review", "มีหลายรายการยอดเท่ากัน"],
    unmatched: ["off", "จับคู่ไม่ได้"], processing: ["", "กำลังประมวลผล"],
  };
  const signatureHelp = (url) => h("details", { class: "small" }, h("summary", {}, "วิธีให้ธนาคารหรือระบบตัวกลางส่งแจ้งเตือนเข้ามา"),
    h("div", { class: "grid mt8" },
      h("p", { class: "m0" }, "ส่ง POST แบบ JSON มาที่ URL ด้านบน 1 ครั้งต่อ 1 รายการเงินเข้า พร้อม header Bizhub-Signature: t=<เวลา unix>,v1=<HMAC-SHA256 ของ \"t.body\" ด้วยรหัสลับ>"),
      h("pre", { class: "secret-box" }, JSON.stringify({ trans_ref: "เลขที่รายการจากธนาคาร", amount: "150.00", paid_at: "2026-10-29T13:45:00+07:00", ref1: "รหัสชำระเงิน (ถ้ามี)", payer_name: "ชื่อผู้โอน (ถ้ามี)" }, null, 2)),
      h("p", { class: "m0 muted" }, "ส่งรายการเดิมซ้ำได้ ระบบจะไม่นับซ้ำ (ดูจาก trans_ref) · ปลายทาง: " + url)));

  /** Lets staff pick which open payment an unmatched transfer pays for (same amount listed first). */
  async function assignEvent(e) {
    const r = await api("/payments?status=pending&limit=100");
    const r2 = await api("/payments?status=awaiting_review&limit=100");
    const open = r.data.concat(r2.data).sort((a, b) => (a.amount === e.amount ? -1 : 0) - (b.amount === e.amount ? -1 : 0));
    if (!open.length) return toast("ไม่มีรายการที่รอชำระให้จับคู่");
    UI.formModal(`จับคู่เงินเข้า ${UI.baht(e.amount)}`, [
      { name: "payment_id", label: `เลือกรายการที่ ${e.payer_name || "ผู้โอน"} ชำระ`, type: "select", value: open[0].id,
        options: open.map((p) => [p.id, `${UI.baht(p.amount)}${p.amount === e.amount ? " ✓ ยอดตรง" : ""} · ${p.reference || p.description || p.id} · ${dt(p.created_at)}`]) },
    ], "ยืนยันการจับคู่", async (v, m) => {
      const res = await api(`/bank/events/${e.id}/assign`, { method: "POST", body: v });
      m.close(); toast(BANK_OUTCOME[res.outcome]?.[1] || res.outcome); viewBank();
    });
  }

  /** The shop's standing "I have paid" page: on/off, link to share and a QR to print. */
  function noticeCard() {
    const m = S.me.merchant;
    const url = location.origin + "/notice/" + m.id;
    const box = h("div", { class: "card grid" });
    const render = () => {
      const on = !!m.notice_enabled;
      const toggle = h("input", { type: "checkbox", id: "notice-on", checked: on ? true : null, disabled: can("bank.manage") ? null : true, onchange: async () => {
        try { await api("/notice", { method: "PATCH", body: { enabled: toggle.checked } }); m.notice_enabled = toggle.checked; toast(toggle.checked ? "เปิดหน้าแจ้งชำระเงินแล้ว" : "ปิดหน้าแจ้งชำระเงินแล้ว"); render(); }
        catch (ex) { toggle.checked = on; toast(ex.message); }
      } });
      box.replaceChildren(
        h("div", { class: "row" }, h("h2", { class: "m0 flex1" }, "หน้าแจ้งชำระเงิน (สำหรับลูกค้าที่โอนเข้าเลขบัญชี)"), on ? h("span", { class: "status on" }, "เปิดอยู่") : h("span", { class: "status" }, "ปิดอยู่")),
        h("p", { class: "m0 small muted" }, "ลิงก์เดียวใช้ได้ตลอด ส่งให้ลูกค้าทาง LINE หรือพิมพ์ QR ไว้ในบิล ลูกค้าที่โอนแล้วกรอกยอด เลขบิล และแนบสลิป ระบบตรวจกับธนาคารและบันทึกเข้ารายการชำระเงินให้ทันที"),
        h("label", { class: "check" }, toggle, "เปิดให้ลูกค้าแจ้งชำระเงินผ่านลิงก์นี้"),
        on ? h("div", { class: "row" },
          h("img", { class: "qr-out", src: "/notice/" + m.id + "/qr.png", alt: "QR หน้าแจ้งชำระเงิน" }),
          h("div", { class: "grid flex1" }, copyField(url), h("div", { class: "row" }, h("a", { class: "btn", href: url, target: "_blank", rel: "noopener" }, "เปิดหน้าแจ้งชำระเงิน")),
            h("p", { class: "m0 small muted" }, "รายการที่ลูกค้าแจ้งจะแสดงในเมนู \"รายการชำระเงิน\" โดยใช้เลขบิลที่ลูกค้ากรอกเป็นเลขอ้างอิง"))) : null);
    };
    render();
    return box;
  }

  async function viewBank() {
    const box = h("div", { class: "grid" }, h("p", { class: "muted" }, "กำลังโหลด…"));
    main.replaceChildren(h("h1", {}, "บัญชีธนาคาร" + (S.me.livemode ? "" : " (โหมดทดสอบ)")), box);
    const res = await api("/bank");
    const c = res.connection;
    const manage = can("bank.manage");
    const cards = [noticeCard()];
    if (!c) {
      cards.push(h("div", { class: "card grid" },
        h("h2", { class: "m0" }, "ยืนยันเงินเข้าอัตโนมัติ ไม่ต้องรอสลิป"),
        h("p", { class: "m0" }, "เมื่อเชื่อมบัญชีแล้ว ธนาคาร (หรือระบบที่ส่งต่อการแจ้งเตือนยอดเข้า) จะแจ้งทุกครั้งที่มีเงินเข้า แล้วระบบจะจับคู่กับรายการชำระเงินและยืนยันให้ทันที"),
        h("ul", { class: "m0 small" },
          h("li", {}, h("b", {}, "มี Biller ID จากธนาคาร: "), "QR ของทุกรายการจะมีรหัสชำระเงินฝังอยู่ ธนาคารแจ้งกลับพร้อมรหัสนี้ จับคู่ได้แม่นยำ 100%"),
          h("li", {}, h("b", {}, "ไม่มี Biller ID: "), "ระบบจับคู่จากยอดเงิน ถ้ามีรายการรอชำระยอดเดียวกันหลายรายการ จะไม่เดาและให้คุณเลือกเอง")),
        manage ? null : h("div", { class: "notice small" }, "เฉพาะเจ้าของร้านที่เชื่อมบัญชีได้")));
      if (manage) {
        const label = h("input", { type: "text", id: "bank-label", required: true, maxlength: "120", placeholder: "เช่น กสิกรไทย ออมทรัพย์ 123-4-xxxxx-0" });
        const biller = h("input", { type: "text", id: "bank-biller", inputmode: "numeric", maxlength: "15", placeholder: "เลข 15 หลัก (ถ้ามี)" });
        const err = h("p", { class: "error", role: "alert" });
        const btn = h("button", { class: "btn primary", type: "submit" }, "เชื่อมบัญชี");
        cards.push(h("form", { class: "card grid narrow", onsubmit: async (e) => {
          e.preventDefault(); err.textContent = ""; btn.disabled = true;
          try {
            const r = await api("/bank", { method: "POST", body: { label: label.value.trim(), biller_id: biller.value.trim() || null } });
            UI.showSecret("เชื่อมบัญชีแล้ว", [["URL สำหรับรับแจ้งเงินเข้า", r.notify_url], ["รหัสลับ (ใช้เซ็นทุกคำขอ)", r.secret]],
              "นำ URL และรหัสลับนี้ไปตั้งค่าที่ธนาคารหรือระบบตัวกลาง รหัสลับแสดงครั้งเดียว");
            viewBank();
          } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
        } },
          h("h2", { class: "m0" }, "เชื่อมบัญชีธนาคาร"),
          h("label", { class: "f", for: "bank-label" }, "ชื่อบัญชี (ไว้ให้พนักงานจำได้)", label),
          h("label", { class: "f", for: "bank-biller" }, "Biller ID", biller, h("span", { class: "small muted" }, "ได้จากธนาคารเมื่อสมัครบริการรับชำระผ่าน QR (เช่น K PLUS SHOP / SCB Business) เว้นว่างได้")),
          err, h("div", { class: "row" }, btn)));
      }
    } else {
      const sim = !S.me.livemode && manage
        ? (() => {
          const sel = h("select", { id: "sim-pay", "aria-label": "เลือกรายการ" }, h("option", { value: "" }, "กำลังโหลดรายการที่รอชำระ…"));
          api("/payments?status=pending&limit=20").then((r) => {
            sel.replaceChildren(...(r.data.length ? r.data.map((p) => h("option", { value: p.id }, `${UI.baht(p.amount)} · ${p.reference || p.description || p.id}`)) : [h("option", { value: "" }, "ไม่มีรายการรอชำระ ลองสร้างลิงก์ก่อน")]));
          });
          return h("div", { class: "card grid" }, h("h2", { class: "m0" }, "ทดลองเงินเข้า (โหมดทดสอบ)"),
            h("p", { class: "m0 small muted" }, "จำลองว่าธนาคารแจ้งเงินเข้าตามยอดของรายการที่เลือก เพื่อดูว่ารายการถูกยืนยันอัตโนมัติ"),
            h("div", { class: "row" }, h("div", { class: "flex1" }, sel), h("button", { class: "btn primary", type: "button", onclick: async () => {
              if (!sel.value) return;
              try { const r = await api("/bank/simulate", { method: "POST", body: { payment_id: sel.value } }); toast(BANK_OUTCOME[r.outcome]?.[1] || r.outcome); viewBank(); }
              catch (ex) { toast(ex.message); }
            } }, "จำลองเงินเข้า")));
        })()
        : null;
      cards.push(h("div", { class: "card grid" },
        h("div", { class: "row" }, h("h2", { class: "m0 flex1" }, c.label), h("span", { class: "status on" }, "เชื่อมแล้ว")),
        h("dl", { class: "kv" },
          h("dt", {}, "วิธีจับคู่"), h("dd", {}, c.matching === "reference" ? "รหัสชำระเงินใน QR (Biller ID " + c.biller_id + ")" : "ยอดเงิน (ไม่มี Biller ID)"),
          h("dt", {}, "แจ้งเตือนล่าสุด"), h("dd", {}, c.last_event_at ? dt(c.last_event_at) : "ยังไม่เคยได้รับ"),
          h("dt", {}, "เชื่อมเมื่อ"), h("dd", {}, dt(c.created_at))),
        h("label", { class: "f" }, "URL สำหรับรับแจ้งเงินเข้า", copyField(c.notify_url)),
        signatureHelp(c.notify_url),
        manage ? h("div", { class: "actions" },
          h("button", { class: "btn", type: "button", onclick: async () => {
            if (!confirm("เปลี่ยนรหัสลับ? ต้องนำรหัสใหม่ไปตั้งที่ธนาคาร/ระบบตัวกลาง ไม่เช่นนั้นการแจ้งเตือนจะถูกปฏิเสธ")) return;
            const r = await api("/bank/rotate-secret", { method: "POST", body: {} });
            UI.showSecret("รหัสลับใหม่", [["รหัสลับ", r.secret]]);
          } }, "เปลี่ยนรหัสลับ"),
          h("button", { class: "btn bad", type: "button", onclick: async () => {
            if (!confirm("ยกเลิกการเชื่อมบัญชี? การแจ้งเตือนเงินเข้าจะถูกปฏิเสธ และ QR ใหม่จะกลับไปเป็น PromptPay ปกติ")) return;
            await api("/bank/disconnect", { method: "POST", body: {} }); toast("ยกเลิกการเชื่อมแล้ว"); viewBank();
          } }, "ยกเลิกการเชื่อม")) : null), sim);
    }
    const ev = res.events;
    cards.push(h("div", { class: "card grid" }, h("h2", { class: "m0" }, "รายการเงินเข้าที่ธนาคารแจ้ง"),
      ev.length ? h("div", { class: "table-wrap" }, h("table", { class: "list" },
        h("thead", {}, h("tr", {}, h("th", {}, "เวลาโอน"), h("th", { class: "num" }, "ยอด"), h("th", {}, "ผู้โอน / อ้างอิง"), h("th", {}, "ผล"), h("th", {}, "รายการ"))),
        h("tbody", {}, ev.map((e) => {
          const [cls, label] = BANK_OUTCOME[e.outcome] || ["", e.outcome];
          return h("tr", { class: e.payment_id ? "click" : "", onclick: e.payment_id ? () => openPayment(e.payment_id) : null },
            h("td", { class: "small" }, dt(e.paid_at)), h("td", { class: "num" }, UI.baht(e.amount)),
            h("td", { class: "small" }, e.payer_name || "-", h("div", { class: "muted mono" }, e.ref1 || e.trans_ref)),
            h("td", {}, h("span", { class: "status " + cls }, label)),
            h("td", { class: "small" }, e.payment_id ? (e.payment_reference || e.payment_description || e.payment_id)
              : can("payments.review") && ["unmatched", "ambiguous"].includes(e.outcome)
                ? h("button", { class: "btn sm", type: "button", onclick: (ev) => { ev.stopPropagation(); assignEvent(e); } }, "จับคู่กับรายการ")
                : "-"));
        }))))
        : h("div", { class: "empty" }, c ? "ยังไม่มีแจ้งเตือนเงินเข้า" : "เชื่อมบัญชีเพื่อเริ่มรับแจ้งเตือน")));
    box.replaceChildren(...cards.filter(Boolean));
  }

  // ---------- shop verification (KYC) ----------
  async function viewKyc() {
    const box = h("div", { class: "grid narrow" }, h("p", { class: "muted" }, "กำลังโหลด…"));
    main.replaceChildren(h("h1", {}, "เปิดรับเงินจริง"), box);
    const res = await api("/kyc");
    const m = res.merchant;
    S.me.merchant = m;
    const k = m.kyc;
    const locked = k.status === "submitted" || k.status === "approved";
    const statusCard = h("div", { class: "card grid" },
      h("div", { class: "row" }, h("h2", { class: "m0 flex1" }, "สถานะ"),
        h("span", { class: "status " + ({ draft: "", submitted: "pending", approved: "on", rejected: "off" }[k.status]) },
          { draft: "ยังไม่ได้ส่ง", submitted: "รอตรวจสอบ", approved: "อนุมัติแล้ว", rejected: "ไม่ผ่าน" }[k.status])),
      k.status === "rejected" ? h("div", { class: "notice" }, "เหตุผล: " + (k.note || "-")) : null,
      k.status === "submitted" ? h("p", { class: "m0 small muted" }, "ส่งเมื่อ " + dt(k.submitted_at) + " · ทีมงานจะแจ้งผลในหน้านี้") : null,
      !locked && res.missing.length ? h("div", {}, h("h3", {}, "ยังขาด"), h("ul", { class: "m0 small" }, res.missing.map((x) => h("li", {}, x)))) : null);

    const f = (id, label, value, attrs = {}) => h("label", { class: "f", for: id }, label, h("input", { id, type: "text", value: value || "", disabled: locked ? true : null, ...attrs }));
    const type = h("select", { id: "k-type", disabled: locked ? true : null },
      h("option", { value: "" }, "เลือก"), h("option", { value: "individual", selected: k.business_type === "individual" ? true : null }, "บุคคลธรรมดา"),
      h("option", { value: "company", selected: k.business_type === "company" ? true : null }, "นิติบุคคล (บริษัท / หจก.)"));
    const err = h("p", { class: "error", role: "alert" });
    const saveBtn = h("button", { class: "btn", type: "submit" }, "บันทึกข้อมูล");
    const val = (id) => document.getElementById(id).value.trim();
    const profile = h("form", { class: "card grid", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ""; saveBtn.disabled = true;
      try {
        await api("/kyc", { method: "PATCH", body: {
          name: val("k-name"), business_type: val("k-type") || undefined, tax_id: val("k-tax"), contact_name: val("k-contact"), contact_phone: val("k-phone"),
          promptpay_id: val("k-pp") || null, bank_name: val("k-bank") || null, bank_account_no: val("k-acct") || null, bank_account_name: val("k-acctname") || null } });
        toast("บันทึกแล้ว"); viewKyc();
      } catch (ex) { err.textContent = ex.message; } finally { saveBtn.disabled = false; }
    } },
      h("h2", { class: "m0" }, "ข้อมูลร้าน"),
      f("k-name", "ชื่อร้าน / ชื่อธุรกิจ", m.name, { required: true }),
      h("label", { class: "f", for: "k-type" }, "ประเภทผู้ประกอบการ", type),
      f("k-tax", "เลขประจำตัวผู้เสียภาษี / เลขบัตรประชาชน (13 หลัก)", k.tax_id, { inputmode: "numeric", maxlength: "17" }),
      h("div", { class: "row" }, f("k-contact", "ชื่อผู้ติดต่อ", k.contact_name), f("k-phone", "เบอร์โทร", k.contact_phone, { type: "tel" })),
      h("h2", { class: "m0 mt8" }, "บัญชีรับเงิน"),
      h("p", { class: "m0 small muted" }, "ต้องเป็นบัญชีในชื่อร้านหรือเจ้าของร้าน หลังอนุมัติแล้ว การเปลี่ยนบัญชีรับเงินต้องติดต่อผู้ดูแลระบบ เพื่อความปลอดภัย"),
      f("k-pp", "พร้อมเพย์ (เบอร์มือถือ / เลขบัตร / เลขผู้เสียภาษี)", m.promptpay_id),
      h("div", { class: "row" }, f("k-bank", "ธนาคาร", m.bank_account?.bank_name), f("k-acct", "เลขที่บัญชี", m.bank_account?.account_no)),
      f("k-acctname", "ชื่อบัญชี", m.bank_account?.account_name),
      err, locked ? null : h("div", { class: "row" }, saveBtn));

    const kindSel = h("select", { id: "doc-kind" }, Object.entries(res.kinds).map(([v, l]) => h("option", { value: v }, l)));
    const fileIn = h("input", { type: "file", id: "doc-file", accept: "image/jpeg,image/png,image/webp,application/pdf" });
    const docs = h("div", { class: "card grid" }, h("h2", { class: "m0" }, "เอกสาร"),
      h("p", { class: "m0 small muted" }, "ภาพถ่ายหรือสแกนที่อ่านได้ชัด (JPG, PNG, WebP หรือ PDF ไม่เกิน 5 MB) แนะนำให้เขียนกำกับบนสำเนาว่า \"ใช้สำหรับสมัคร Bizhub เท่านั้น\""),
      res.documents.length ? h("div", { class: "table-wrap" }, h("table", { class: "list" }, h("tbody", {}, res.documents.map((d) => h("tr", {},
        h("td", {}, h("span", { class: "ref" }, d.kind_label), h("span", { class: "small muted" }, d.filename + " · " + Math.ceil(d.size / 1024) + " KB")),
        h("td", { class: "num" }, h("div", { class: "actions" },
          h("button", { class: "btn sm", type: "button", onclick: async () => { const { url } = await api.blobUrl("/kyc/documents/" + d.id); window.open(url, "_blank", "noopener"); } }, "เปิดดู"),
          locked ? null : h("button", { class: "btn sm bad", type: "button", onclick: async () => { if (!confirm("ลบเอกสารนี้?")) return; await api("/kyc/documents/" + d.id + "/delete", { method: "POST", body: {} }); viewKyc(); } }, "ลบ")))))))) : h("p", { class: "m0 muted small" }, "ยังไม่มีเอกสาร"),
      locked ? null : h("label", { class: "f", for: "doc-kind" }, "ประเภทเอกสาร", kindSel),
      locked ? null : h("div", { class: "row" }, h("div", { class: "flex1" }, fileIn), h("button", { class: "btn", type: "button", onclick: async (e) => {
        if (!fileIn.files[0]) return toast("เลือกไฟล์ก่อน");
        e.currentTarget.disabled = true;
        try {
          const fd = new FormData(); fd.append("kind", kindSel.value); fd.append("file", fileIn.files[0]);
          const r = await fetch("/dashboard/api/kyc/documents", { method: "POST", body: fd, headers: { "X-Requested-With": "bizhub-web" }, credentials: "same-origin" });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error?.message || "อัปโหลดไม่สำเร็จ");
          toast("อัปโหลดแล้ว"); viewKyc();
        } catch (ex) { toast(ex.message); e.currentTarget.disabled = false; }
      } }, "อัปโหลด")));

    const submit = !locked ? h("div", { class: "card grid" }, h("h2", { class: "m0" }, "ส่งให้ทีมงานตรวจ"),
      h("p", { class: "m0 small muted" }, "ระหว่างรอผลใช้โหมดทดสอบได้ตามปกติ เมื่ออนุมัติแล้วจะเปิดโหมดใช้งานจริงให้อัตโนมัติ"),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", disabled: res.missing.length ? true : null, onclick: async () => {
        try { await api("/kyc/submit", { method: "POST", body: {} }); toast("ส่งตรวจแล้ว"); S.me = await api("/me"); viewKyc(); } catch (ex) { toast(ex.message); }
      } }, "ส่งตรวจ"), res.missing.length ? h("span", { class: "small muted" }, "กรอกข้อมูลและแนบเอกสารให้ครบก่อน") : null)) : null;
    box.replaceChildren(...[statusCard, profile, docs, submit].filter(Boolean));
  }

  async function viewAudit() {
    const box = h("div", { class: "card grid" });
    main.replaceChildren(h("h1", {}, "ประวัติการใช้งาน"), box);
    let rows = [];
    const more = async () => {
      const res = await api("/audit" + (rows.length ? "?before=" + encodeURIComponent(rows[rows.length - 1].created_at) : ""));
      rows = rows.concat(res.data);
      box.replaceChildren(...[UI.auditTable(rows, {}), res.data.length === 50 ? h("div", { class: "row center" }, h("button", { class: "btn", type: "button", onclick: more }, "โหลดเพิ่ม")) : null].filter(Boolean));
    };
    await more();
  }

  // ---------- the shop's own bill ----------
  async function viewBilling() {
    const r = await api("/billing");
    const c = r.current;
    const pay = async (i) => {
      const { url } = await api(`/invoices/${i.id}/pay`, { method: "POST", body: {} });
      window.open(url, "_blank", "noopener");
    };
    main.replaceChildren(h("h1", {}, "ค่าบริการ"), h("div", { class: "grid" },
      h("div", { class: "card grid" },
        h("h2", { class: "m0" }, c ? `รอบ ${UI.periodLabel(c.period)} (ถึงวันนี้)` : "แพ็กเกจ"),
        c ? [
          h("p", { class: "m0" }, h("strong", {}, c.plan.name), " — ", UI.planText(c.plan)),
          h("p", { class: "m0 small muted" }, `ชำระสำเร็จ ${c.transaction_count.toLocaleString("th-TH")} รายการ ยอด ${baht(c.volume)} · ยอดนี้เป็นการประมาณ ใบแจ้งหนี้จะออกต้นเดือนถัดไป`),
          UI.chargeLines(c),
        ] : h("p", { class: "m0 muted" }, "ร้านของคุณยังไม่มีแพ็กเกจค่าบริการ กรุณาติดต่อผู้ให้บริการ")),
      h("div", { class: "card grid" }, h("h2", { class: "m0" }, "ใบแจ้งหนี้"),
        r.invoices.length ? UI.invoiceTable(r.invoices, {
          docUrl: (i) => `/dashboard/api/invoices/${i.id}/document`,
          actions: (i) => i.status === "issued" ? [h("button", { class: "btn sm primary", type: "button", onclick: () => pay(i).catch((ex) => toast(ex.message)) }, "ชำระเงิน")] : [],
        }) : h("div", { class: "empty" }, "ยังไม่มีใบแจ้งหนี้"))));
  }

  // ---------- settings ----------
  async function viewSettings() {
    const m = S.me.merchant;
    const cards = [
      h("div", { class: "card" }, h("h2", {}, "บัญชีของฉัน"), h("dl", { class: "kv" },
        h("dt", {}, "ชื่อ"), h("dd", {}, S.me.user.name), h("dt", {}, "บทบาท"), h("dd", {}, S.me.user.role_label)),
        S.me.user.kind === "merchant_user" ? h("div", { class: "row mt12" }, h("button", { class: "btn", type: "button", onclick: () => {
          UI.changePasswordView(root, { api, forced: false, onDone: () => go("settings") });
        } }, "เปลี่ยนรหัสผ่าน")) : null),
    ];
    if (S.me.user.kind === "merchant_user") {
      const nameInput = h("input", {type:"text",value:S.me.user.name,required:true,maxlength:120,autocomplete:"name"});
      const form = h("form",{class:"card grid",onsubmit:async(e)=>{
        e.preventDefault();
        const name = nameInput.value.trim();
        if (!name) { toast("กรุณากรอกชื่อผู้ใช้"); return; }
        try {
          const result = await api("/profile",{method:"PATCH",body:{name}});
          S.me.user.name = result.name;
          toast("บันทึกโปรไฟล์แล้ว");
          go("settings");
        } catch (ex) { toast(ex.message); }
      }},h("h2",{},"แก้ไขโปรไฟล์ส่วนตัว"),
        h("label",{class:"f"},"ชื่อที่แสดง",nameInput),
        h("p",{class:"small muted"},"ชื่อที่แสดงในมุมขวาบนของระบบ"),
        h("button",{class:"btn primary",type:"submit"},"บันทึกชื่อ"));
      cards.push(form);
    }
    if (S.me.user.kind === "merchant_user" && S.me.user.role === "owner") {
      const password = h("input",{type:"password",autocomplete:"current-password",required:true,placeholder:"รหัสผ่านบัญชีเจ้าของร้าน"});
      const result = h("div",{class:"grid",hidden:true});
      const btn = h("button",{class:"btn danger",type:"submit"},"ยืนยันและออก Live Secret Key ใหม่");
      const form = h("form",{class:"card grid",onsubmit:async(e)=>{
        e.preventDefault();
        if (!window.confirm("Live Secret Key เดิมจะใช้งานไม่ได้ทันที ระบบที่เชื่อมต่ออยู่ต้องเปลี่ยนเป็น Key ใหม่ ยืนยันหรือไม่?")) return;
        btn.disabled=true;
        try {
          const r=await api("/keys/live/rotate",{method:"POST",body:{password:password.value,confirm:true}});
          password.value="";
          const field=h("input",{type:"text",readOnly:true,value:r.live_secret_key,autocomplete:"off",spellcheck:false,class:"mono"});
          const copy=h("button",{class:"btn",type:"button",onclick:()=>navigator.clipboard.writeText(field.value).then(()=>toast("คัดลอกแล้ว")).catch(()=>toast("คัดลอกไม่สำเร็จ"))},"คัดลอก Key");
          result.hidden=false;
          result.replaceChildren(h("p",{class:"small"},"Live Secret Key ใหม่ (แสดงครั้งเดียว กรุณาจัดเก็บในที่ปลอดภัย)"),field,copy);
          toast("ออก Live Secret Key ใหม่แล้ว");
        }catch(ex){toast(ex.message);}
        finally{btn.disabled=false;}
      }},
        h("h2",{},"ออก Live Secret Key ใหม่"),
        h("p",{class:"small muted"},"เฉพาะเจ้าของร้าน • Key เดิมจะถูกยกเลิกทันทีหลังยืนยัน • Test Key ไม่เปลี่ยน"),
        h("label",{class:"f"},"ยืนยันด้วยรหัสผ่านเจ้าของร้าน",password),btn,result);
      cards.push(form);
    }
    if (S.me.user.kind === "merchant_user") {
      const mfaBox = h("div");
      cards.push(mfaBox);
      UI.twoFactorCard(mfaBox, { api }).catch((ex) => mfaBox.replaceChildren(h("p", { class: "error" }, ex.message)));
    }
    if (can("settings.view")) {
      cards.push(h("div", { class: "card" }, h("h2", {}, "ข้อมูลรับเงิน"), h("dl", { class: "kv" },
        h("dt", {}, "ชื่อร้าน"), h("dd", {}, m.name),
        h("dt", {}, "PromptPay"), h("dd", {}, m.promptpay_id || "ยังไม่ได้ตั้งค่า"),
        h("dt", {}, "บัญชีธนาคาร"), h("dd", {}, m.bank_account ? [m.bank_account.bank_name, m.bank_account.account_no, m.bank_account.account_name].filter(Boolean).join(" · ") : "ยังไม่ได้ตั้งค่า"),
        h("dt", {}, "รหัสร้าน"), h("dd", { class: "mono" }, m.id)),
        h("p", { class: "small muted" }, "ต้องการแก้ไขข้อมูลรับเงิน กรุณาติดต่อผู้ดูแลเกตเวย์")));
      const pv = h("input", { type: "text", id: "privacy-url", value: m.privacy_url || "", placeholder: "https://ชื่อบริษัท.com/privacy", disabled: can("users.manage") ? null : true });
      cards.push(h("div", { class: "card grid" }, h("h2", { class: "m0" }, "ความเป็นส่วนตัว (PDPA)"),
        h("p", { class: "m0 small muted" }, "ลูกค้าจะเห็นข้อความแจ้งการใช้ข้อมูลในสลิปทุกครั้งที่แนบสลิป พร้อมลิงก์นโยบายของร้าน (ถ้าใส่) และนโยบายของระบบ"),
        h("label", { class: "f", for: "privacy-url" }, "ลิงก์นโยบายความเป็นส่วนตัวของร้าน", pv),
        can("users.manage") ? h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: async () => {
          try { const r = await api("/privacy", { method: "PATCH", body: { privacy_url: pv.value.trim() || null } }); m.privacy_url = r.privacy_url; toast("บันทึกแล้ว"); }
          catch (ex) { toast(ex.message); }
        } }, "บันทึก"), h("a", { class: "btn", href: "/privacy", target: "_blank", rel: "noopener" }, "ดูนโยบายของระบบ")) : null));
      const deliveries = h("div", {}, h("p", { class: "muted" }, "กำลังโหลด…"));
      const secret = S.me.webhook_secret
        ? (() => {
          const input = h("input", { type: "password", readonly: true, value: S.me.webhook_secret });
          const reveal = h("button", { class: "btn", type: "button", onclick: () => { const show = input.type === "password"; input.type = show ? "text" : "password"; reveal.textContent = show ? "ซ่อน" : "แสดง"; } }, "แสดง");
          return h("label", { class: "f" }, "Webhook secret (ใช้ตรวจลายเซ็น Bizhub-Signature)",
            h("div", { class: "copy-field" }, input, reveal, h("button", { class: "btn", type: "button", onclick: () => UI.copyText(S.me.webhook_secret) }, "คัดลอก")));
        })()
        : null;
      cards.push(h("div", { class: "card grid" }, h("h2", { class: "m0" }, "Webhook"),
        h("dl", { class: "kv" }, h("dt", {}, "URL"), h("dd", {}, m.webhook_url || "ยังไม่ได้ตั้งค่า")), secret,
        h("h3", { class: "mt8" }, "การส่ง webhook ล่าสุด"), deliveries));
      api("/webhooks").then((res) => {
        const ST = { delivered: "ส่งสำเร็จ", pending: "รอส่ง/ส่งซ้ำ", failed: "ล้มเหลว" };
        deliveries.replaceChildren(res.data.length ? h("div", { class: "table-wrap" }, h("table", { class: "list" },
          h("thead", {}, h("tr", {}, h("th", {}, "เวลา"), h("th", {}, "เหตุการณ์"), h("th", {}, "ผล"), h("th", { class: "num" }, "ครั้งที่ส่ง"))),
          h("tbody", {}, res.data.map((d) => h("tr", {}, h("td", { class: "small" }, dt(d.created_at)), h("td", { class: "small" }, d.event_type),
            h("td", { class: "small" }, (ST[d.status] || d.status) + (d.last_error ? " (" + d.last_error + ")" : "")), h("td", { class: "num" }, d.attempts))))))
          : h("div", { class: "empty" }, m.webhook_url ? "ยังไม่มีการส่ง" : "ยังไม่ได้ตั้งค่า webhook URL"));
      }).catch(() => deliveries.replaceChildren(h("p", { class: "error" }, "โหลดไม่ได้")));
    }
    main.replaceChildren(h("h1", {}, "ตั้งค่า"), h("div", { class: "grid" }, ...cards));
  }

  // ---------- boot ----------
  async function boot() {
    try { S.me = await api("/me", { allow401: true }); } catch { return showLogin(); }
    if (S.me.user.must_change_password) return UI.changePasswordView(root, { api, forced: true, onDone: boot });
    if (S.me.user.mfa_setup_required) {
      return UI.mfaSetupRequiredView(root, {
        api, onDone: boot,
        onLogout: async () => { await api("/logout", { method: "POST" }).catch(() => {}); showLogin(); },
        reason: MFA_REASON,
      });
    }
    // Prefer production data for approved merchant accounts. Never mislabel test data as real.
    if (!S.me.livemode && S.me.user.kind === "merchant_user" && S.me.merchant.kyc.status === "approved") {
      try {
        await api("/mode", {method:"POST",body:{livemode:true}});
        S.me = await api("/me");
      } catch (error) {
        console.warn("Could not switch to live data", error);
      }
    }
    S.summary = can("payments.view") ? await api("/summary").catch(() => null) : null;
    go(S.tab);
  }
  setInterval(() => {
    if (!S.me || document.hidden || document.querySelector(".drawer,.modal")) return;
    if (S.tab === "overview") viewOverview().catch(() => {});
  }, 30000);
  boot();
})();
