/* Merchant dashboard. What each tab shows and which buttons appear follow the signed-in user's permissions. */
(() => {
  "use strict";
  const { h, baht, dt, statusBadge, toast, copyField, makeApi } = UI;
  const root = document.getElementById("app");
  const api = makeApi("/dashboard/api", () => showLogin());
  const S = { me: null, tab: "overview", filter: "", q: "", list: [], hasMore: false, summary: null };
  const can = (p) => S.me && S.me.permissions.includes(p);
  let main;

  function showLogin() {
    S.me = null;
    UI.loginView(root, {
      title: "Bizhub Dashboard",
      subtitle: "เข้าสู่ระบบด้วยบัญชีพนักงานของร้าน",
      altLabel: "เข้าด้วย Secret key (เจ้าของร้าน)",
      altField: { name: "secret_key", label: "Secret key", placeholder: "sk_live_... หรือ sk_test_...", hint: "ใช้ sk_test_ เพื่อดูข้อมูลทดสอบ หรือ sk_live_ เพื่อดูข้อมูลจริง ระบบไม่เก็บ key ไว้ในเบราว์เซอร์" },
      onSubmit: async (body) => { await api("/login", { method: "POST", body, allow401: true }); await boot(); },
    });
  }

  const TABS = [
    { id: "overview", label: "ภาพรวม", perm: "payments.view" },
    { id: "payments", label: "รายการชำระเงิน", perm: "payments.view" },
    { id: "create", label: "สร้างลิงก์ชำระเงิน", perm: "payments.create" },
    { id: "team", label: "พนักงาน", perm: "users.manage" },
    { id: "audit", label: "ประวัติการใช้งาน", perm: "audit.view" },
    { id: "settings", label: "ตั้งค่า", perm: null },
  ];

  function renderShell() {
    const m = S.me.merchant;
    const review = S.summary?.awaiting_review || 0;
    const modeSwitch = S.me.user.kind === "merchant_user"
      ? h("span", { class: "mode-switch", role: "group", "aria-label": "โหมดข้อมูล" },
        [[true, "ข้อมูลจริง"], [false, "ทดสอบ"]].map(([live, label]) => h("button", { type: "button", "aria-pressed": String(S.me.livemode === live), onclick: async () => {
          if (S.me.livemode === live) return;
          await api("/mode", { method: "POST", body: { livemode: live } });
          S.me.livemode = live; S.summary = null; S.list = []; go(S.tab);
        } }, label)))
      : h("span", { class: "pill " + (S.me.livemode ? "live" : "test") }, S.me.livemode ? "ใช้งานจริง" : "โหมดทดสอบ");
    main = UI.shell(root, {
      brand: "Bizhub", subtitle: m.name,
      extra: modeSwitch,
      user: S.me.user,
      tabs: TABS.filter((t) => !t.perm || can(t.perm)).map((t) => ({ ...t, badge: t.id === "payments" && review ? review : null })),
      current: S.tab,
      onTab: go,
      onLogout: async () => { await api("/logout", { method: "POST" }).catch(() => {}); showLogin(); },
    });
  }

  function go(tab) {
    const t = TABS.find((x) => x.id === tab);
    if (!t || (t.perm && !can(t.perm))) tab = TABS.find((x) => !x.perm || can(x.perm)).id;
    S.tab = tab;
    renderShell();
    const views = { overview: viewOverview, payments: viewPayments, create: viewCreate, team: viewTeam, audit: viewAudit, settings: viewSettings };
    Promise.resolve(views[tab]()).catch((ex) => main.replaceChildren(h("p", { class: "error" }, ex.message)));
  }

  const openPayment = (id) => UI.openPayment(api, id, {
    caps: { review: can("payments.review"), cancel: can("payments.cancel") },
    onChange: () => { if (S.tab === "overview") viewOverview(); else if (S.tab === "payments") reloadList(); },
  });

  // ---------- overview ----------
  async function viewOverview() {
    main.replaceChildren(h("h1", {}, "ภาพรวม"), h("p", { class: "muted" }, "กำลังโหลด…"));
    const [summary, review] = await Promise.all([api("/summary"), api("/payments?status=awaiting_review&limit=5")]);
    const changed = S.summary?.awaiting_review !== summary.awaiting_review;
    S.summary = summary;
    if (changed) renderShell();
    const tile = (label, value, sub, extra = {}) => h("div", { class: "card tile" + (extra.attn ? " attn" : "") },
      h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null, extra.action || null);
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", {}, "ภาพรวม"),
        can("payments.export") ? h("button", { class: "btn", type: "button", onclick: () => UI.exportDialog(api, "/payments/export") }, "ส่งออก Excel/CSV") : null),
      h("div", { class: "grid" },
        h("div", { class: "grid tiles" },
          tile("ยอดขายวันนี้", baht(summary.today.amount), summary.today.count + " รายการ"),
          tile(`ยอดขาย ${summary.period.days} วัน`, baht(summary.period.amount), summary.period.count + " รายการ"),
          tile("รอตรวจสอบ", String(summary.awaiting_review), "สลิปที่ระบบตัดสินเองไม่ได้", {
            attn: summary.awaiting_review > 0,
            action: summary.awaiting_review > 0 ? h("button", { class: "link", type: "button", onclick: () => { S.filter = "awaiting_review"; go("payments"); } }, "ไปตรวจสอบ →") : null,
          }),
          tile("รอชำระ", String(summary.pending), "ลูกค้ายังไม่จ่าย")),
        UI.salesChart(summary.daily, "ยอดขายรายวัน (ชำระสำเร็จ)"),
        h("div", { class: "card" }, h("h2", {}, "รอตรวจสอบล่าสุด"),
          review.data.length ? UI.paymentTable(review.data, { onOpen: openPayment }) : h("div", { class: "empty" }, "ไม่มีรายการที่ต้องตรวจสอบ ✓"))));
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
    main.replaceChildren(h("h1", {}, "พนักงาน"),
      h("div", { class: "grid" }, h("div", { class: "notice info small" }, "เพิ่มบัญชีให้พนักงานแต่ละคน แล้วเลือกบทบาทตามหน้าที่ ทุกการกระทำจะถูกบันทึกในประวัติการใช้งานพร้อมชื่อผู้ทำ"), box));
    await UI.usersPanel(box, { api, base: "/users", roles: S.me.roles, title: "บัญชีพนักงาน", canManage: true });
  }

  // ---------- audit ----------
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
    if (can("settings.view")) {
      cards.push(h("div", { class: "card" }, h("h2", {}, "ข้อมูลรับเงิน"), h("dl", { class: "kv" },
        h("dt", {}, "ชื่อร้าน"), h("dd", {}, m.name),
        h("dt", {}, "PromptPay"), h("dd", {}, m.promptpay_id || "ยังไม่ได้ตั้งค่า"),
        h("dt", {}, "บัญชีธนาคาร"), h("dd", {}, m.bank_account ? [m.bank_account.bank_name, m.bank_account.account_no, m.bank_account.account_name].filter(Boolean).join(" · ") : "ยังไม่ได้ตั้งค่า"),
        h("dt", {}, "รหัสร้าน"), h("dd", { class: "mono" }, m.id)),
        h("p", { class: "small muted" }, "ต้องการแก้ไขข้อมูลรับเงิน กรุณาติดต่อผู้ดูแลเกตเวย์")));
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
    S.summary = can("payments.view") ? await api("/summary").catch(() => null) : null;
    go(S.tab);
  }
  setInterval(() => {
    if (!S.me || document.hidden || document.querySelector(".drawer,.modal")) return;
    if (S.tab === "overview") viewOverview().catch(() => {});
  }, 30000);
  boot();
})();
