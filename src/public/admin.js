/* Admin console for gateway operators. Tabs and buttons follow the signed-in admin's role. */
(() => {
  "use strict";
  const { h, baht, dt, toast, makeApi } = UI;
  const root = document.getElementById("app");
  const api = makeApi("/admin/console/api", () => showLogin());
  const S = { me: null, tab: "overview", live: true, filter: "", q: "", merchantFilter: "", list: [], hasMore: false, merchants: [] };
  const can = (p) => S.me && S.me.permissions.includes(p);
  const MFA_REASON = "ระบบกำหนดให้บัญชีแอดมินทุกคนใช้การยืนยันตัวตน 2 ชั้น กรุณาตั้งค่าให้เสร็จก่อนเริ่มใช้งาน";
  let main;

  function showLogin() {
    S.me = null;
    UI.loginView(root, {
      title: "Bizhub Admin", brandClass: "brand admin",
      subtitle: "สำหรับผู้ดูแลระบบเกตเวย์",
      altLabel: "เข้าด้วย ADMIN_TOKEN",
      altField: { name: "admin_token", label: "ADMIN_TOKEN", placeholder: "ค่าจากไฟล์ .env", hint: "ใช้ตอนติดตั้งครั้งแรกเพื่อสร้างบัญชีแอดมิน หลังจากนั้นควรใช้บัญชีส่วนตัว" },
      onSubmit: async (body) => {
        const r = await api("/login", { method: "POST", body, allow401: true });
        if (r.mfa_required) return UI.mfaPrompt(root, { api, token: r.mfa_token, onDone: boot, onBack: showLogin });
        await boot();
      },
    });
  }

  const TABS = [
    { id: "overview", label: "ภาพรวม", perm: "payments.view" },
    { id: "merchants", label: "ร้านค้า", perm: "merchants.view" },
    { id: "kyc", label: "คำขอเปิดร้าน", perm: "merchants.view" },
    { id: "payments", label: "รายการชำระเงิน", perm: "payments.view" },
    { id: "webhooks", label: "Webhook", perm: "merchants.view" },
    { id: "admins", label: "บัญชีแอดมิน", perm: "admins.manage" },
    { id: "audit", label: "ประวัติการใช้งาน", perm: "audit.view" },
    { id: "account", label: "บัญชีของฉัน", perm: null },
  ];

  function renderShell(badges = {}) {
    const modeSwitch = h("span", { class: "mode-switch", role: "group", "aria-label": "โหมดข้อมูล" },
      [[true, "ข้อมูลจริง"], [false, "ทดสอบ"]].map(([live, label]) => h("button", { type: "button", "aria-pressed": String(S.live === live), onclick: () => {
        if (S.live !== live) { S.live = live; S.list = []; go(S.tab); }
      } }, label)));
    main = UI.shell(root, {
      brand: "Bizhub Admin", brandClass: "admin",
      extra: modeSwitch,
      user: S.me.user,
      tabs: TABS.filter((t) => !t.perm || can(t.perm)).map((t) => ({ ...t, badge: badges[t.id] || null })),
      current: S.tab, onTab: go,
      onLogout: async () => { await api("/logout", { method: "POST" }).catch(() => {}); showLogin(); },
    });
  }

  function go(tab) {
    const t = TABS.find((x) => x.id === tab);
    if (!t || (t.perm && !can(t.perm))) tab = TABS.find((x) => !x.perm || can(x.perm)).id;
    S.tab = tab;
    renderShell(S.badges);
    const views = { overview: viewOverview, merchants: viewMerchants, kyc: viewKycQueue, payments: viewPayments, webhooks: viewWebhooks, admins: viewAdmins, audit: viewAudit, account: viewAccount };
    Promise.resolve(views[tab]()).catch((ex) => main.replaceChildren(h("p", { class: "error" }, ex.message)));
  }

  const openPayment = (id) => UI.openPayment(api, id, {
    caps: { review: can("payments.review"), cancel: false }, showMerchant: true,
    onChange: () => { if (S.tab === "payments") reloadList(); else if (S.tab === "overview") viewOverview(); },
  });

  // ---------- overview ----------
  async function viewOverview() {
    main.replaceChildren(h("h1", {}, "ภาพรวมทั้งระบบ"), h("p", { class: "muted" }, "กำลังโหลด…"));
    const s = await api("/summary?livemode=" + S.live);
    S.badges = { payments: s.awaiting_review || null, webhooks: s.failed_webhooks || null, kyc: s.pending_kyc || null };
    renderShell(S.badges);
    const tile = (label, value, sub, cls, action) => h("div", { class: "card tile " + (cls || "") }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null, action || null);
    const maxTop = Math.max(1, ...s.top_merchants.map((m) => m.amount));
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", {}, "ภาพรวมทั้งระบบ" + (S.live ? "" : " (ทดสอบ)")),
        can("payments.export") ? h("button", { class: "btn", type: "button", onclick: () => UI.exportDialog(api, "/payments/export", { livemode: String(S.live) }) }, "ส่งออก Excel/CSV") : null),
      h("div", { class: "grid" },
        h("div", { class: "grid tiles" },
          tile("ยอดผ่านเกตเวย์วันนี้", baht(s.today.amount), s.today.count + " รายการ"),
          tile(`ยอด ${s.period.days} วัน`, baht(s.period.amount), s.period.count + " รายการ"),
          tile("ร้านค้าที่เปิดใช้งาน", String(s.merchants.active), `จากทั้งหมด ${s.merchants.total} ร้าน`),
          tile("ต้องดูแล", String(s.awaiting_review + s.failed_webhooks), `สลิปรอตรวจ ${s.awaiting_review} · webhook ล้มเหลว ${s.failed_webhooks}`,
            s.failed_webhooks ? "alert" : s.awaiting_review ? "attn" : "",
            s.failed_webhooks ? h("button", { class: "link", type: "button", onclick: () => go("webhooks") }, "ดู webhook ที่ล้มเหลว →") : null)),
        h("div", { class: "grid cols-2" },
          UI.salesChart(s.daily, "ยอดชำระสำเร็จรายวัน (ทุกร้าน)"),
          h("div", { class: "card" }, h("h2", {}, `ร้านค้ายอดสูงสุด ${s.period.days} วัน`),
            s.top_merchants.length ? h("div", { class: "grid" }, s.top_merchants.map((m) => h("div", { class: "hbar" },
              h("span", {}, m.name), h("span", { class: "small num" }, baht(m.amount)),
              h("div", { class: "track" }, h("div", { class: "fill", "data-w": String(Math.round((m.amount / maxTop) * 100)) })))))
              : h("div", { class: "empty" }, "ยังไม่มียอดขาย")))));
    // Widths via CSSOM (inline style attributes are blocked by the CSP).
    main.querySelectorAll(".fill[data-w]").forEach((el) => { el.style.width = el.dataset.w + "%"; });
  }

  // ---------- merchants ----------
  const merchantFields = (m = {}) => [
    { name: "name", label: "ชื่อร้าน", value: m.name, required: true, maxlength: 120 },
    { name: "promptpay_id", label: "PromptPay ID (เบอร์มือถือ / เลขบัตร / เลขผู้เสียภาษี)", value: m.promptpay_id || "" },
    { name: "bank_name", label: "ธนาคาร", value: m.bank_account?.bank_name || "" },
    { name: "bank_account_no", label: "เลขที่บัญชี", value: m.bank_account?.account_no || "" },
    { name: "bank_account_name", label: "ชื่อบัญชี", value: m.bank_account?.account_name || "" },
    { name: "webhook_url", label: "Webhook URL", type: "text", value: m.webhook_url || "", placeholder: "https://..." },
    { name: "privacy_url", label: "ลิงก์นโยบายความเป็นส่วนตัวของร้าน (PDPA)", type: "text", value: m.privacy_url || "", placeholder: "https://..." },
  ];
  const nullIfEmpty = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === "" ? null : x]));

  async function viewMerchants() {
    const box = h("div", { class: "card grid" }, h("p", { class: "muted" }, "กำลังโหลด…"));
    let timer;
    const search = h("input", { type: "search", placeholder: "ค้นหาชื่อร้าน / รหัสร้าน / PromptPay", value: S.q, "aria-label": "ค้นหาร้านค้า",
      oninput: () => { clearTimeout(timer); timer = setTimeout(() => { S.q = search.value.trim(); load(); }, 250); } });
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", {}, "ร้านค้า"),
        can("merchants.manage") ? h("button", { class: "btn primary", type: "button", onclick: createMerchant }, "+ เพิ่มร้านค้า") : null),
      h("div", { class: "grid" }, search, box));
    const load = async () => {
      const res = await api("/merchants" + (S.q ? "?q=" + encodeURIComponent(S.q) : ""));
      S.merchants = res.data;
      box.replaceChildren(res.data.length ? h("div", { class: "table-wrap" }, h("table", { class: "list" },
        h("thead", {}, h("tr", {}, h("th", {}, "ร้านค้า"), h("th", {}, "สถานะ"), h("th", { class: "num" }, "ยอด 30 วัน (จริง)"), h("th", { class: "num" }, "รอตรวจ"), h("th", { class: "num" }, "พนักงาน"), h("th", {}, "รายการล่าสุด"))),
        h("tbody", {}, res.data.map((m) => h("tr", { class: "click", tabindex: "0", onclick: () => openMerchant(m.id), onkeydown: (e) => { if (e.key === "Enter") openMerchant(m.id); } },
          h("td", {}, h("span", { class: "ref" }, m.name), h("span", { class: "small muted mono" }, m.id)),
          h("td", {}, m.active ? h("span", { class: "status on" }, "เปิดใช้งาน") : h("span", { class: "status off" }, "ปิดใช้งาน")),
          h("td", { class: "num" }, baht(m.volume_30d)),
          h("td", { class: "num" }, m.awaiting_review ? h("span", { class: "status awaiting_review" }, m.awaiting_review) : "0"),
          h("td", { class: "num" }, m.staff),
          h("td", { class: "small" }, m.last_payment_at ? dt(m.last_payment_at) : "-"))))))
        : h("div", { class: "empty" }, S.q ? "ไม่พบร้านค้า" : "ยังไม่มีร้านค้า"));
    };
    await load();
    viewMerchants.reload = load;
  }

  function createMerchant() {
    UI.formModal("เพิ่มร้านค้า", [
      ...merchantFields(),
      { name: "owner_name", label: "ชื่อเจ้าของร้าน (สร้างบัญชีเข้า Dashboard ให้ด้วย)", value: "", hint: "เว้นว่างได้ถ้ายังไม่ต้องการสร้างบัญชี" },
      { name: "owner_email", label: "อีเมลเจ้าของร้าน", type: "email", value: "" },
    ], "สร้างร้านค้า", async (v, m) => {
      const { owner_name, owner_email, ...fields } = v;
      if ((owner_name && !owner_email) || (!owner_name && owner_email)) throw new Error("กรอกชื่อและอีเมลเจ้าของร้านให้ครบ หรือเว้นว่างทั้งคู่");
      const created = await api("/merchants", { method: "POST", body: nullIfEmpty(fields) });
      const lines = [["Test secret key", created.test_secret_key], ["Live secret key", created.live_secret_key], ["Webhook secret", created.webhook_secret]];
      if (owner_email) {
        try {
          const u = await api(`/merchants/${created.id}/users`, { method: "POST", body: { name: owner_name, email: owner_email, role: "owner" } });
          lines.push(["บัญชีเจ้าของร้าน", u.email], ["รหัสผ่านชั่วคราว", u.temporary_password]);
        } catch (ex) { toast("สร้างร้านแล้ว แต่สร้างบัญชีเจ้าของไม่สำเร็จ: " + ex.message); }
      }
      m.close();
      UI.showSecret("สร้างร้าน " + created.name + " แล้ว", lines, "ข้อมูลเหล่านี้แสดงครั้งเดียว ส่งให้ร้านค้าผ่านช่องทางที่ปลอดภัย");
      if (viewMerchants.reload) viewMerchants.reload();
    });
  }

  function openMerchant(id) {
    const d = UI.drawer("ข้อมูลร้านค้า");
    const render = async () => {
      const m = await api("/merchants/" + id);
      const usersBox = h("div");
      const manage = can("merchants.manage");
      d.body.replaceChildren(
        h("div", {}, h("div", { class: "amount-lg" }, m.name), h("div", { class: "row mt8" },
          m.active ? h("span", { class: "status on" }, "เปิดใช้งาน") : h("span", { class: "status off" }, "ปิดใช้งาน"), h("span", { class: "small muted mono" }, m.id))),
        h("div", { class: "grid tiles" },
          h("div", { class: "card tile" }, h("div", { class: "label" }, "วันนี้"), h("div", { class: "value" }, baht(m.summary.today.amount))),
          h("div", { class: "card tile" }, h("div", { class: "label" }, "14 วัน"), h("div", { class: "value" }, baht(m.summary.period.amount))),
          h("div", { class: "card tile" }, h("div", { class: "label" }, "รอตรวจ"), h("div", { class: "value" }, String(m.summary.awaiting_review))),
          h("div", { class: "card tile" }, h("div", { class: "label" }, "รอชำระ"), h("div", { class: "value" }, String(m.summary.pending)))),
        manage ? h("div", { class: "actions" },
          h("button", { class: "btn", type: "button", onclick: () => UI.formModal("แก้ไข " + m.name, [...merchantFields(m), { name: "require_2fa", label: "บังคับพนักงานของร้านใช้ 2FA", type: "checkbox", value: m.require_2fa }], "บันทึก", async (v, mm) => {
            await api("/merchants/" + id, { method: "PATCH", body: nullIfEmpty(v) }); mm.close(); toast("บันทึกแล้ว"); await render(); viewMerchants.reload && viewMerchants.reload();
          }) }, "แก้ไขข้อมูล"),
          h("button", { class: "btn " + (m.active ? "bad" : "good"), type: "button", onclick: async () => {
            if (!confirm(m.active ? `ปิดใช้งาน ${m.name}? API key และการเข้า Dashboard ของร้านจะใช้ไม่ได้ทันที` : `เปิดใช้งาน ${m.name} อีกครั้ง?`)) return;
            await api("/merchants/" + id, { method: "PATCH", body: { active: !m.active } }); toast("บันทึกแล้ว"); await render(); viewMerchants.reload && viewMerchants.reload();
          } }, m.active ? "ปิดใช้งานร้าน" : "เปิดใช้งานร้าน"),
          h("button", { class: "btn", type: "button", onclick: async () => {
            if (!confirm("ออก API key ใหม่? key เดิมจะใช้ไม่ได้ทันที และเซสชันที่เข้าด้วย key เดิมจะถูกออกจากระบบ")) return;
            const k = await api(`/merchants/${id}/rotate-keys`, { method: "POST", body: {} });
            UI.showSecret("API key ใหม่ของ " + m.name, [["Test secret key", k.test_secret_key], ["Live secret key", k.live_secret_key]]); await render();
          } }, "ออก API key ใหม่"),
          h("button", { class: "btn", type: "button", onclick: async () => {
            if (!confirm("เปลี่ยน webhook secret? ร้านต้องอัปเดตค่าในระบบของตนเพื่อให้ตรวจลายเซ็นผ่าน")) return;
            const r = await api(`/merchants/${id}/rotate-webhook-secret`, { method: "POST", body: {} });
            UI.showSecret("Webhook secret ใหม่", [["Webhook secret", r.webhook_secret]]);
          } }, "เปลี่ยน webhook secret")) : null,
        h("dl", { class: "kv" },
          h("dt", {}, "PromptPay"), h("dd", {}, m.promptpay_id || "-"),
          h("dt", {}, "บัญชีธนาคาร"), h("dd", {}, m.bank_account ? [m.bank_account.bank_name, m.bank_account.account_no, m.bank_account.account_name].filter(Boolean).join(" · ") : "-"),
          h("dt", {}, "Webhook URL"), h("dd", {}, m.webhook_url || "-"),
          h("dt", {}, "บังคับ 2FA"), h("dd", {}, m.require_2fa ? "ใช่" : "ไม่"),
          h("dt", {}, "เชื่อมบัญชีธนาคาร"), h("dd", {}, (m.bank_connections || []).length
            ? m.bank_connections.map((b) => `${b.label} (${b.livemode ? "จริง" : "ทดสอบ"}, ${b.matching === "reference" ? "Biller ID" : "จับคู่ยอด"}${b.last_event_at ? ", แจ้งล่าสุด " + dt(b.last_event_at) : ""})`).join(" · ")
            : "ยังไม่เชื่อม"),
          h("dt", {}, "API key ที่ใช้งาน"), h("dd", { class: "mono" }, m.api_keys.map((k) => `${k.key_prefix}… (${k.livemode ? "live" : "test"})`).join(", ") || "-"),
          h("dt", {}, "สร้างเมื่อ"), h("dd", {}, dt(m.created_at))),
        h("div", { class: "row" },
          can("payments.view") ? h("button", { class: "btn sm", type: "button", onclick: () => { d.close(); S.merchantFilter = id; S.filter = ""; go("payments"); } }, "ดูรายการของร้านนี้") : null,
          can("audit.view") ? h("button", { class: "btn sm", type: "button", onclick: () => { d.close(); S.auditMerchant = id; go("audit"); } }, "ดูประวัติของร้านนี้") : null),
        usersBox);
      await UI.usersPanel(usersBox, { api, base: `/merchants/${id}/users`, roles: S.me.merchant_roles, title: "บัญชีเข้า Dashboard ของร้าน", canManage: can("merchant_users.manage"), rows: m.users });
    };
    d.body.append(h("p", { class: "muted" }, "กำลังโหลด…"));
    render().catch((ex) => d.body.replaceChildren(h("p", { class: "error" }, ex.message)));
  }

  // ---------- shop verification queue ----------
  const KYC_LABEL = { draft: ["", "ยังไม่ส่ง"], submitted: ["pending", "รอตรวจ"], approved: ["on", "อนุมัติแล้ว"], rejected: ["off", "ไม่ผ่าน"] };
  async function viewKycQueue() {
    let filter = "submitted";
    const box = h("div");
    const chips = h("div", { class: "chips" }, [["submitted", "รอตรวจ"], ["rejected", "ไม่ผ่าน"], ["draft", "ยังไม่ส่ง"], ["approved", "อนุมัติแล้ว"]].map(([v, l]) =>
      h("button", { class: "chip", type: "button", "aria-pressed": String(v === filter), onclick: (e) => {
        filter = v; chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget))); load();
      } }, l)));
    main.replaceChildren(h("h1", {}, "คำขอเปิดร้าน"), h("div", { class: "card grid" },
      h("p", { class: "m0 small muted" }, "ร้านที่สมัครเองใช้ได้เฉพาะโหมดทดสอบจนกว่าจะอนุมัติ ตรวจว่าเอกสารตรงกับชื่อร้าน เลขผู้เสียภาษี และบัญชีรับเงิน"), chips, box));
    const load = async () => {
      const res = await api("/merchants?kyc=" + filter);
      box.replaceChildren(res.data.length ? h("div", { class: "table-wrap" }, h("table", { class: "list" },
        h("thead", {}, h("tr", {}, h("th", {}, "ร้านค้า"), h("th", {}, "สถานะ"), h("th", {}, "ส่งเมื่อ"))),
        h("tbody", {}, res.data.map((m) => h("tr", { class: "click", tabindex: "0", onclick: () => openKyc(m.id, load) },
          h("td", {}, h("span", { class: "ref" }, m.name), h("span", { class: "small muted" }, (m.kyc.contact_name || "") + " · " + (m.kyc.contact_phone || ""))),
          h("td", {}, h("span", { class: "status " + KYC_LABEL[m.kyc.status][0] }, KYC_LABEL[m.kyc.status][1])),
          h("td", { class: "small" }, m.kyc.submitted_at ? dt(m.kyc.submitted_at) : "-"))))))
        : h("div", { class: "empty" }, filter === "submitted" ? "ไม่มีคำขอรอตรวจ ✓" : "ไม่มีรายการ"));
    };
    await load();
  }

  function openKyc(id, onDone) {
    const d = UI.drawer("ตรวจเอกสารร้าน");
    const urls = [];
    const render = async () => {
      const m = await api("/merchants/" + id);
      const k = m.kyc;
      const docBoxes = m.kyc_documents.map((doc) => {
        const slot = h("div", { class: "grid" }, h("h3", { class: "m0" }, doc.kind_label), h("p", { class: "muted small m0" }, "กำลังโหลด…"));
        api.blobUrl(`/merchants/${id}/kyc-documents/${doc.id}`).then(({ url, type }) => {
          urls.push(url);
          slot.replaceChildren(h("h3", { class: "m0" }, doc.kind_label), type === "application/pdf"
            ? h("a", { href: url, target: "_blank", rel: "noopener" }, "เปิด " + doc.filename + " (PDF)")
            : h("a", { href: url, target: "_blank", rel: "noopener" }, h("img", { class: "slip-img", src: url, alt: doc.kind_label })));
        }).catch(() => slot.replaceChildren(h("p", { class: "error" }, "โหลดเอกสารไม่ได้")));
        return slot;
      });
      d.body.replaceChildren(...[
        h("div", {}, h("div", { class: "amount-lg" }, m.name), h("div", { class: "row mt8" }, h("span", { class: "status " + KYC_LABEL[k.status][0] }, KYC_LABEL[k.status][1]))),
        h("dl", { class: "kv" },
          h("dt", {}, "ประเภท"), h("dd", {}, { individual: "บุคคลธรรมดา", company: "นิติบุคคล" }[k.business_type] || "-"),
          h("dt", {}, "เลขผู้เสียภาษี"), h("dd", { class: "mono" }, k.tax_id || "-"),
          h("dt", {}, "ผู้ติดต่อ"), h("dd", {}, (k.contact_name || "-") + " · " + (k.contact_phone || "-")),
          h("dt", {}, "บัญชีอีเมล"), h("dd", {}, (m.users || []).map((u) => u.email).join(", ") || "-"),
          h("dt", {}, "พร้อมเพย์"), h("dd", { class: "mono" }, m.promptpay_id || "-"),
          h("dt", {}, "บัญชีธนาคาร"), h("dd", {}, m.bank_account ? [m.bank_account.bank_name, m.bank_account.account_no, m.bank_account.account_name].filter(Boolean).join(" · ") : "-"),
          k.note ? [h("dt", {}, "หมายเหตุล่าสุด"), h("dd", {}, k.note)] : null),
        m.kyc_missing.length ? h("div", { class: "notice small" }, "ยังขาด: " + m.kyc_missing.join(", ")) : null,
        ...docBoxes,
        k.status === "submitted" && can("merchants.manage") ? h("div", { class: "actions" },
          h("button", { class: "btn good", type: "button", onclick: async () => {
            if (!confirm(`อนุมัติ ${m.name}? ร้านจะเปิดรับเงินจริงได้ทันที`)) return;
            await api(`/merchants/${id}/kyc-review`, { method: "POST", body: { decision: "approve" } }); toast("อนุมัติแล้ว"); await render(); onDone && onDone();
          } }, "อนุมัติ"),
          h("button", { class: "btn bad", type: "button", onclick: () => UI.formModal("ไม่อนุมัติ " + m.name, [
            { name: "note", label: "เหตุผล (ร้านจะเห็นข้อความนี้)", required: true, value: "", placeholder: "เช่น ภาพสมุดบัญชีไม่ชัด ชื่อบัญชีไม่ตรงกับชื่อร้าน" },
          ], "ส่งผล", async (v, mm) => { await api(`/merchants/${id}/kyc-review`, { method: "POST", body: { decision: "reject", note: v.note } }); mm.close(); toast("แจ้งผลแล้ว"); await render(); onDone && onDone(); }) }, "ไม่อนุมัติ")) : null,
      ].filter(Boolean));
    };
    d.body.append(h("p", { class: "muted" }, "กำลังโหลด…"));
    render().catch((ex) => d.body.replaceChildren(h("p", { class: "error" }, ex.message)));
  }

  // ---------- payments ----------
  async function loadPayments(more) {
    const params = new URLSearchParams({ limit: "25", livemode: String(S.live) });
    if (S.filter) params.set("status", S.filter);
    if (S.pq) params.set("q", S.pq);
    if (S.merchantFilter) params.set("merchant_id", S.merchantFilter);
    if (more && S.list.length) params.set("starting_after", S.list[S.list.length - 1].id);
    const res = await api("/payments?" + params);
    S.list = more ? S.list.concat(res.data) : res.data;
    S.hasMore = res.has_more;
  }
  let listBox;
  function renderList() {
    listBox.replaceChildren(...[
      S.list.length ? UI.paymentTable(S.list, { onOpen: openPayment, showMerchant: true }) : h("div", { class: "empty" }, "ไม่พบรายการ"),
      S.hasMore ? h("div", { class: "row center mt12" }, h("button", { class: "btn", type: "button", onclick: async () => { await loadPayments(true); renderList(); } }, "โหลดเพิ่ม")) : null,
    ].filter(Boolean));
  }
  async function reloadList() { await loadPayments(false); renderList(); }

  async function viewPayments() {
    if (!S.merchants.length && can("merchants.view")) S.merchants = (await api("/merchants")).data;
    listBox = h("div");
    const FILTERS = [["", "ทั้งหมด"], ...Object.entries(UI.STATUS).map(([k, v]) => [k, v[1]])];
    const chips = h("div", { class: "chips", role: "group", "aria-label": "กรองสถานะ" }, FILTERS.map(([v, label]) =>
      h("button", { class: "chip", type: "button", "aria-pressed": String(S.filter === v), onclick: async (e) => {
        S.filter = v; chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget))); await reloadList();
      } }, label)));
    const merchantSel = h("select", { "aria-label": "เลือกร้านค้า", onchange: async () => { S.merchantFilter = merchantSel.value; await reloadList(); } },
      h("option", { value: "" }, "ทุกร้านค้า"), S.merchants.map((m) => h("option", { value: m.id, selected: m.id === S.merchantFilter ? true : null }, m.name)));
    let timer;
    const search = h("input", { type: "search", placeholder: "ค้นหาเลขอ้างอิง / รายละเอียด / รหัสรายการ", value: S.pq || "", "aria-label": "ค้นหา",
      oninput: () => { clearTimeout(timer); timer = setTimeout(async () => { S.pq = search.value.trim(); await reloadList(); }, 300); } });
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", {}, "รายการชำระเงินทุกร้าน" + (S.live ? "" : " (ทดสอบ)")),
        can("payments.export") ? h("button", { class: "btn", type: "button", onclick: () => UI.exportDialog(api, "/payments/export", {
          livemode: String(S.live), ...(S.merchantFilter ? { merchant_id: S.merchantFilter } : {}), ...(S.pq ? { q: S.pq } : {}) }) }, "ส่งออก Excel/CSV") : null),
      h("div", { class: "card grid" }, h("div", { class: "row" }, h("div", { class: "flex1" }, search), merchantSel), chips, listBox));
    await reloadList();
  }

  // ---------- webhooks ----------
  async function viewWebhooks() {
    let status = "failed";
    const box = h("div");
    const chips = h("div", { class: "chips" }, [["failed", "ล้มเหลว"], ["pending", "รอส่ง/ส่งซ้ำ"], ["delivered", "ส่งสำเร็จ"], ["", "ทั้งหมด"]].map(([v, l]) =>
      h("button", { class: "chip", type: "button", "aria-pressed": String(v === status), onclick: (e) => {
        status = v; chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget))); load();
      } }, l)));
    main.replaceChildren(h("h1", {}, "Webhook"), h("div", { class: "card grid" }, chips, box));
    const ST = { delivered: "ส่งสำเร็จ", pending: "รอส่ง/ส่งซ้ำ", failed: "ล้มเหลว" };
    const load = async () => {
      const res = await api("/webhooks" + (status ? "?status=" + status : ""));
      box.replaceChildren(res.data.length ? h("div", { class: "table-wrap" }, h("table", { class: "list" },
        h("thead", {}, h("tr", {}, h("th", {}, "เวลา"), h("th", {}, "ร้านค้า"), h("th", {}, "เหตุการณ์"), h("th", {}, "ปลายทาง"), h("th", {}, "ผล"), h("th", { class: "num" }, "ครั้ง"), h("th", {}, ""))),
        h("tbody", {}, res.data.map((d) => h("tr", {},
          h("td", { class: "small" }, dt(d.created_at)), h("td", {}, d.merchant_name), h("td", { class: "small" }, d.event_type),
          h("td", { class: "small mono" }, d.url),
          h("td", { class: "small" }, h("span", { class: "status " + (d.status === "delivered" ? "on" : d.status === "failed" ? "off" : "pending") }, ST[d.status] || d.status),
            d.last_error ? h("div", { class: "muted" }, d.last_error) : null),
          h("td", { class: "num" }, d.attempts),
          h("td", {}, can("webhooks.manage") && d.status !== "delivered" ? h("button", { class: "btn sm", type: "button", onclick: async () => {
            await api(`/webhooks/${d.id}/retry`, { method: "POST", body: {} }); toast("จะส่งใหม่ภายในไม่กี่วินาที"); load();
          } }, "ส่งใหม่") : null))))))
        : h("div", { class: "empty" }, status === "failed" ? "ไม่มี webhook ที่ล้มเหลว ✓" : "ไม่มีรายการ"));
    };
    await load();
  }

  // ---------- admins ----------
  async function viewAdmins() {
    const box = h("div");
    main.replaceChildren(h("h1", {}, "บัญชีแอดมิน"), box);
    await UI.usersPanel(box, { api, base: "/admins", roles: S.me.roles, title: "ผู้ดูแลระบบ", canManage: true });
  }

  // ---------- audit ----------
  async function viewAudit() {
    if (!S.merchants.length && can("merchants.view")) S.merchants = (await api("/merchants")).data;
    const box = h("div", { class: "grid" });
    const sel = h("select", { "aria-label": "เลือกร้านค้า", onchange: () => { S.auditMerchant = sel.value; rows = []; more(); } },
      h("option", { value: "" }, "ทุกร้านค้าและระบบ"), S.merchants.map((m) => h("option", { value: m.id, selected: m.id === S.auditMerchant ? true : null }, m.name)));
    main.replaceChildren(h("h1", {}, "ประวัติการใช้งาน"), h("div", { class: "card grid" }, h("div", { class: "row" }, sel), box));
    let rows = [];
    const more = async () => {
      const params = new URLSearchParams();
      if (S.auditMerchant) params.set("merchant_id", S.auditMerchant);
      if (rows.length) params.set("before", rows[rows.length - 1].created_at);
      const res = await api("/audit?" + params);
      rows = rows.concat(res.data);
      box.replaceChildren(...[UI.auditTable(rows, { showMerchant: true }), res.data.length === 50 ? h("div", { class: "row center" }, h("button", { class: "btn", type: "button", onclick: more }, "โหลดเพิ่ม")) : null].filter(Boolean));
    };
    await more();
  }

  // ---------- my account ----------
  function viewAccount() {
    const mfaBox = h("div", { class: "narrow" });
    if (S.me.user.kind === "admin_user") UI.twoFactorCard(mfaBox, { api }).catch((ex) => mfaBox.replaceChildren(h("p", { class: "error" }, ex.message)));
    main.replaceChildren(h("h1", {}, "บัญชีของฉัน"), h("div", { class: "grid" }, h("div", { class: "card narrow" },
      h("dl", { class: "kv" }, h("dt", {}, "ชื่อ"), h("dd", {}, S.me.user.name), h("dt", {}, "บทบาท"), h("dd", {}, S.me.user.role_label)),
      S.me.user.kind === "admin_user"
        ? h("div", { class: "row mt12" }, h("button", { class: "btn", type: "button", onclick: () => UI.changePasswordView(root, { api, forced: false, onDone: () => go("account") }) }, "เปลี่ยนรหัสผ่าน"))
        : h("div", { class: "notice mt12" }, "คุณเข้าด้วย ADMIN_TOKEN ซึ่งมีสิทธิ์สูงสุด แนะนำให้สร้างบัญชีแอดมินส่วนตัวที่เมนู \"บัญชีแอดมิน\" แล้วใช้บัญชีนั้นแทน")), mfaBox));
  }

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
    go(S.tab);
  }
  boot();
})();
