/** The merchant dashboard: one static page that talks to /dashboard/api. All data is rendered with textContent. */
export function renderDashboardPage(nonce: string): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bizhub Dashboard</title>
<style nonce="${nonce}">
  :root {
    --bg:#f5f6f8; --surface:#ffffff; --surface-2:#f9fafb; --fg:#1d2330; --muted:#667085; --line:#e4e7ec; --grid:#eef0f3;
    --accent:#1a56db; --accent-soft:#e8effd; --bar:#3b6fe0; --bar-hover:#1a4fc4;
    --good:#067647; --good-bg:#e7f6ec; --warn:#b54708; --warn-bg:#fef3e2; --bad:#b42318; --bad-bg:#fdecea; --neutral-bg:#eef0f3;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#0f1218; --surface:#181c24; --surface-2:#1e232d; --fg:#e8eaf0; --muted:#98a2b3; --line:#2a303c; --grid:#232935;
    --accent:#7aa2ff; --accent-soft:#1f2a44; --bar:#6f97f5; --bar-hover:#9ab6ff;
    --good:#47cd89; --good-bg:#12291d; --warn:#fdb022; --warn-bg:#2e2410; --bad:#f97066; --bad-bg:#331816; --neutral-bg:#262c38;
  } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, "Noto Sans Thai", sans-serif; }
  button, input, select { font:inherit; color:inherit; }
  [hidden] { display:none !important; }
  .wrap { max-width:1120px; margin:0 auto; padding:0 16px; }
  header.top { background:var(--surface); border-bottom:1px solid var(--line); }
  header.top .wrap { display:flex; align-items:center; gap:12px; min-height:56px; flex-wrap:wrap; }
  .brand { font-weight:700; }
  .shop { color:var(--muted); }
  .mode { font-size:12px; font-weight:600; padding:2px 8px; border-radius:999px; background:var(--warn-bg); color:var(--warn); }
  .mode.live { background:var(--good-bg); color:var(--good); }
  .spacer { flex:1; }
  nav.tabs { display:flex; gap:4px; overflow-x:auto; }
  nav.tabs button { background:none; border:0; padding:14px 12px; cursor:pointer; color:var(--muted); border-bottom:2px solid transparent; white-space:nowrap; }
  nav.tabs button[aria-current="page"] { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
  .badge-count { display:inline-block; min-width:20px; padding:0 6px; margin-left:4px; border-radius:999px; background:var(--warn-bg); color:var(--warn); font-size:12px; font-weight:700; text-align:center; }
  main { padding:24px 0 48px; }
  h1 { font-size:20px; margin:0 0 16px; }
  h2 { font-size:16px; margin:0 0 12px; }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:20px; }
  .grid { display:grid; gap:16px; }
  .tiles { grid-template-columns:repeat(4, minmax(0,1fr)); }
  @media (max-width:860px) { .tiles { grid-template-columns:repeat(2, minmax(0,1fr)); } }
  @media (max-width:520px) { .tile { padding:14px; } .tile .value { font-size:20px; } .card { padding:16px; } header.top .btn { padding:4px 10px; font-size:13px; } }
  .tile .label { color:var(--muted); font-size:13px; }
  .tile .value { font-size:26px; font-weight:700; margin-top:4px; font-variant-numeric:tabular-nums; }
  .tile .sub { color:var(--muted); font-size:13px; }
  .tile.attn { border-color:var(--warn); }
  .tile button.link { margin-top:4px; }
  .error:empty { display:none; }
  .btn { white-space:nowrap; border:1px solid var(--line); background:var(--surface); padding:8px 14px; border-radius:8px; cursor:pointer; font-weight:500; }
  .btn:hover { background:var(--surface-2); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .btn.good { background:var(--good); border-color:var(--good); color:#fff; }
  .btn.bad { color:var(--bad); border-color:var(--bad); }
  .btn:disabled { opacity:.55; cursor:wait; }
  button.link { background:none; border:0; padding:0; color:var(--accent); cursor:pointer; font-weight:500; }
  input[type=text], input[type=search], input[type=password], input[type=number], select {
    padding:9px 12px; border:1px solid var(--line); border-radius:8px; background:var(--surface); width:100%; }
  label.f { display:flex; flex-direction:column; gap:6px; font-size:13px; color:var(--muted); }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
  .muted { color:var(--muted); }
  .small { font-size:13px; }
  .error { color:var(--bad); font-size:14px; min-height:1.2em; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .chip { border:1px solid var(--line); background:var(--surface); padding:5px 12px; border-radius:999px; cursor:pointer; font-size:13px; }
  .chip[aria-pressed="true"] { background:var(--accent-soft); border-color:var(--accent); color:var(--accent); font-weight:600; }
  table.list { width:100%; border-collapse:collapse; }
  table.list th { text-align:left; font-size:12px; font-weight:600; color:var(--muted); padding:8px 10px; border-bottom:1px solid var(--line); }
  table.list td { padding:12px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }
  table.list tbody tr { cursor:pointer; }
  table.list tbody tr:hover, table.list tbody tr:focus-visible { background:var(--surface-2); outline:none; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .ref { font-weight:500; } .ref + .small { display:block; }
  @media (max-width:700px) {
    table.list thead { display:none; }
    table.list tbody tr { display:grid; grid-template-columns:1fr auto; grid-template-areas:"ref amount" "date status"; gap:4px 12px; padding:12px 4px; border-bottom:1px solid var(--line); }
    table.list td { padding:0; border:0; }
    table.list td.c-ref { grid-area:ref; } table.list td.c-amount { grid-area:amount; font-weight:600; }
    table.list td.c-date { grid-area:date; color:var(--muted); font-size:13px; } table.list td.c-status { grid-area:status; text-align:right; }
    table.list td.c-method { display:none; }
  }
  .status { display:inline-flex; align-items:center; gap:4px; padding:2px 9px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; background:var(--neutral-bg); color:var(--muted); }
  .status.succeeded { background:var(--good-bg); color:var(--good); }
  .status.awaiting_review { background:var(--warn-bg); color:var(--warn); }
  .status.failed { background:var(--bad-bg); color:var(--bad); }
  .status.pending { background:var(--accent-soft); color:var(--accent); }
  .empty { padding:32px; text-align:center; color:var(--muted); }
  /* chart */
  .chart-head { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .chart { position:relative; margin-top:12px; }
  .chart svg { display:block; overflow:visible; }
  .chart .gridline { stroke:var(--grid); stroke-width:1; }
  .chart .axis { fill:var(--muted); font-size:11px; }
  .chart .bar { fill:var(--bar); }
  .chart .col:hover .bar, .chart .col:focus .bar { fill:var(--bar-hover); }
  .chart .col { outline:none; cursor:default; }
  .chart .hit { fill:transparent; }
  .tooltip { position:absolute; pointer-events:none; background:var(--fg); color:var(--bg); padding:6px 10px; border-radius:8px; font-size:12px; white-space:nowrap; transform:translate(-50%, calc(-100% - 8px)); }
  .tooltip b { font-variant-numeric:tabular-nums; }
  /* drawer */
  .scrim { position:fixed; inset:0; background:rgba(15,18,24,.45); z-index:10; }
  .drawer { position:fixed; top:0; right:0; bottom:0; width:min(520px, 100%); background:var(--surface); z-index:11; overflow-y:auto; box-shadow:-8px 0 24px rgba(0,0,0,.15); }
  .drawer header { position:sticky; top:0; background:var(--surface); display:flex; align-items:center; gap:12px; padding:16px 20px; border-bottom:1px solid var(--line); }
  .drawer .body { padding:20px; display:flex; flex-direction:column; gap:20px; }
  .amount-lg { font-size:28px; font-weight:700; font-variant-numeric:tabular-nums; }
  dl.kv { display:grid; grid-template-columns:max-content 1fr; gap:8px 16px; margin:0; }
  dl.kv dt { color:var(--muted); font-size:13px; } dl.kv dd { margin:0; word-break:break-all; }
  .slip-img { max-width:100%; border:1px solid var(--line); border-radius:8px; background:var(--surface-2); }
  .verify { border-radius:10px; padding:12px 14px; background:var(--neutral-bg); }
  .verify.verified { background:var(--good-bg); } .verify.rejected { background:var(--bad-bg); } .verify.needs_review { background:var(--warn-bg); }
  .verify strong { display:block; }
  .actions { display:flex; gap:8px; flex-wrap:wrap; }
  .login { max-width:420px; margin:10vh auto; }
  .login p { color:var(--muted); }
  .copy-field { display:flex; gap:8px; } .copy-field input { font-family:ui-monospace, monospace; font-size:13px; }
  .qr-out { display:block; width:200px; height:200px; background:#fff; padding:8px; border-radius:8px; border:1px solid var(--line); }
  .toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:var(--fg); color:var(--bg); padding:10px 16px; border-radius:8px; z-index:20; font-size:14px; }
  .center-mt { justify-content:center; margin-top:12px; } .gap12 { gap:12px; } .m0 { margin:0; } .flex1 { flex:1; }
  .mt6 { margin-top:6px; } .mt8 { margin-top:8px; } .narrow { max-width:560px; } table.list tbody tr.nocursor { cursor:default; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
(() => {
  // ---------- helpers ----------
  const app = document.getElementById("app");
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const kid of kids) el.append(kid);
    return el;
  };
  const baht = (satang) => "฿" + (satang / 100).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const bahtShort = (satang) => {
    const b = satang / 100;
    return b >= 1e6 ? (b / 1e6).toFixed(1).replace(/\\.0$/, "") + "M" : b >= 1e3 ? (b / 1e3).toFixed(1).replace(/\\.0$/, "") + "k" : String(Math.round(b));
  };
  // Sales are bucketed by Thai calendar day on the server, so always display Thai time.
  const TZ = "Asia/Bangkok";
  const dt = (iso) => iso ? new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: TZ }) : "-";
  const dayLabel = (d) => new Date(d + "T12:00:00+07:00").toLocaleDateString("th-TH", { day: "numeric", month: "short", timeZone: TZ });

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

  function statusBadge(s) {
    const [icon, label] = STATUS[s] || ["", s];
    return h("span", { class: "status " + s }, h("span", { "aria-hidden": "true" }, icon), label);
  }

  function toast(msg) {
    const t = h("div", { class: "toast", role: "status" }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 2500);
  }

  async function api(path, opts = {}) {
    const res = await fetch("/dashboard/api" + path, {
      method: opts.method || "GET",
      headers: { "X-Requested-With": "bizhub-dashboard", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    if (res.status === 401 && path !== "/login") { showLogin(); throw new Error("กรุณาเข้าสู่ระบบ"); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || "เกิดข้อผิดพลาด");
    return j;
  }

  function copyField(value) {
    const input = h("input", { type: "text", readonly: true, value });
    const btn = h("button", { class: "btn", type: "button", onclick: () => navigator.clipboard.writeText(value).then(() => toast("คัดลอกแล้ว")) }, "คัดลอก");
    return h("div", { class: "copy-field" }, input, btn);
  }

  // ---------- state ----------
  const S = { me: null, tab: "overview", filter: "", q: "", list: [], hasMore: false, summary: null };

  // ---------- login ----------
  function showLogin() {
    S.me = null;
    const err = h("p", { class: "error", role: "alert" });
    const key = h("input", { type: "password", id: "key", autocomplete: "off", placeholder: "sk_live_... หรือ sk_test_...", required: true });
    const btn = h("button", { class: "btn primary", type: "submit" }, "เข้าสู่ระบบ");
    const form = h("form", { class: "card login", onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.textContent = "";
      try { await api("/login", { method: "POST", body: { secret_key: key.value } }); await boot(); }
      catch (ex) { err.textContent = ex.message === "Invalid secret key" ? "Secret key ไม่ถูกต้อง" : ex.message; }
      finally { btn.disabled = false; }
    } },
      h("h1", {}, "Bizhub Dashboard"),
      h("p", {}, "เข้าสู่ระบบด้วย Secret key ของร้าน ใช้ sk_test_ เพื่อดูข้อมูลทดสอบ หรือ sk_live_ เพื่อดูข้อมูลจริง"),
      h("label", { class: "f", for: "key" }, "Secret key", key),
      err,
      h("div", { class: "row" }, btn),
      h("p", { class: "small" }, "ระบบไม่เก็บ key ไว้ในเบราว์เซอร์ และจะออกจากระบบอัตโนมัติใน 12 ชั่วโมง"),
    );
    app.replaceChildren(h("div", { class: "wrap" }, form));
    key.focus();
  }

  // ---------- shell ----------
  const TABS = [["overview", "ภาพรวม"], ["payments", "รายการชำระเงิน"], ["create", "สร้างลิงก์ชำระเงิน"], ["settings", "ตั้งค่า"]];
  let mainEl;

  function renderShell() {
    const m = S.me.merchant;
    const review = S.summary?.awaiting_review || 0;
    const nav = h("nav", { class: "tabs", "aria-label": "เมนู" }, TABS.map(([id, label]) =>
      h("button", { type: "button", "aria-current": S.tab === id ? "page" : null, onclick: () => go(id) },
        label, id === "payments" && review ? h("span", { class: "badge-count", title: "รอตรวจสอบ" }, review) : null)));
    const top = h("header", { class: "top" }, h("div", { class: "wrap" },
      h("span", { class: "brand" }, "Bizhub"),
      h("span", { class: "shop" }, m.name),
      h("span", { class: "mode" + (S.me.livemode ? " live" : "") }, S.me.livemode ? "ใช้งานจริง" : "โหมดทดสอบ"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: async () => { await api("/logout", { method: "POST" }).catch(() => {}); showLogin(); } }, "ออกจากระบบ"),
    ), h("div", { class: "wrap" }, nav));
    mainEl = h("main", { class: "wrap" });
    app.replaceChildren(top, mainEl);
  }

  function go(tab) {
    S.tab = tab;
    renderShell();
    ({ overview: viewOverview, payments: viewPayments, create: viewCreate, settings: viewSettings })[tab]();
  }

  // ---------- overview ----------
  async function viewOverview() {
    mainEl.replaceChildren(h("h1", {}, "ภาพรวม"), h("p", { class: "muted" }, "กำลังโหลด…"));
    const [summary, review] = await Promise.all([api("/summary"), api("/payments?status=awaiting_review&limit=5")]);
    const changed = S.summary?.awaiting_review !== summary.awaiting_review;
    S.summary = summary;
    if (changed) renderShell();
    const tile = (label, value, sub, extra) => h("div", { class: "card tile" + (extra?.attn ? " attn" : "") },
      h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null, extra?.action || null);
    const tiles = h("div", { class: "grid tiles" },
      tile("ยอดขายวันนี้", baht(summary.today.amount), summary.today.count + " รายการ"),
      tile("ยอดขาย " + summary.period.days + " วัน", baht(summary.period.amount), summary.period.count + " รายการ"),
      tile("รอตรวจสอบ", String(summary.awaiting_review), "สลิปที่ระบบตัดสินเองไม่ได้", {
        attn: summary.awaiting_review > 0,
        action: summary.awaiting_review > 0 ? h("button", { class: "link", type: "button", onclick: () => { S.filter = "awaiting_review"; go("payments"); } }, "ไปตรวจสอบ →") : null,
      }),
      tile("รอชำระ", String(summary.pending), "ลูกค้ายังไม่จ่าย"),
    );
    const reviewCard = h("div", { class: "card" }, h("h2", {}, "รอตรวจสอบล่าสุด"),
      review.data.length ? paymentTable(review.data) : h("div", { class: "empty" }, "ไม่มีรายการที่ต้องตรวจสอบ ✓"));
    mainEl.replaceChildren(h("h1", {}, "ภาพรวม"), h("div", { class: "grid" }, tiles, salesChart(summary), reviewCard));
  }

  /** Daily sales, single series: one hue, rounded data-ends on the baseline, hover tooltip, table fallback. */
  function salesChart(summary) {
    const data = summary.daily;
    const wrap = h("div", { class: "chart" });
    const tip = h("div", { class: "tooltip", hidden: true });
    const niceStep = (raw) => {
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((v) => v >= raw);
    };
    const max = Math.max(...data.map((d) => d.amount), 0);
    const step = niceStep(Math.max(max, 40000) / 4);
    const top = step * 4;

    // Drawn at the container's real width so text and bar widths stay true at every screen size.
    const draw = () => {
      const W = Math.max(280, wrap.clientWidth), H = 220, padL = 48, padB = 24, padT = 8;
      const plotW = W - padL, plotH = H - padB - padT;
      const colW = plotW / data.length, bw = Math.max(4, Math.min(40, colW - 4));
      const y = (v) => padT + plotH - (v / top) * plotH;
      const chart = svg("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": "กราฟยอดขายรายวัน " + data.length + " วัน" });
      for (let i = 0; i <= 4; i++) {
        const yy = y(step * i);
        chart.append(svg("line", { class: "gridline", x1: padL, x2: W, y1: yy, y2: yy }));
        const t = svg("text", { class: "axis", x: padL - 8, y: yy + 4, "text-anchor": "end" }); t.textContent = bahtShort(step * i); chart.append(t);
      }
      const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(plotW / 64)));
      data.forEach((d, i) => {
        const x = padL + i * colW + (colW - bw) / 2;
        const col = svg("g", { class: "col", tabindex: "0", "aria-label": dayLabel(d.date) + " " + baht(d.amount) + " " + d.count + " รายการ" });
        col.append(svg("rect", { class: "hit", x: padL + i * colW, y: padT, width: colW, height: plotH }));
        if (d.amount > 0) {
          const yt = y(d.amount), yb = y(0), r = Math.min(4, bw / 2, yb - yt);
          col.append(svg("path", { class: "bar", d: "M" + x + "," + yb + "V" + (yt + r) + "Q" + x + "," + yt + " " + (x + r) + "," + yt +
            "H" + (x + bw - r) + "Q" + (x + bw) + "," + yt + " " + (x + bw) + "," + (yt + r) + "V" + yb + "Z" }));
        }
        if ((data.length - 1 - i) % labelEvery === 0) {
          const t = svg("text", { class: "axis", x: padL + i * colW + colW / 2, y: H - 6, "text-anchor": "middle" });
          t.textContent = i === data.length - 1 ? "วันนี้" : dayLabel(d.date); chart.append(t);
        }
        const show = () => {
          tip.replaceChildren(dayLabel(d.date) + " · ", h("b", {}, baht(d.amount)), " · " + d.count + " รายการ");
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
      h("tbody", {}, data.slice().reverse().map((d) => h("tr", { class: "nocursor" }, h("td", {}, dayLabel(d.date)), h("td", { class: "num" }, d.count), h("td", { class: "num" }, baht(d.amount))))));
    const toggle = h("button", { class: "link", type: "button", onclick: () => {
      const showTable = table.hidden; table.hidden = !showTable; wrap.hidden = showTable; toggle.textContent = showTable ? "ดูเป็นกราฟ" : "ดูเป็นตาราง";
    } }, "ดูเป็นตาราง");
    return h("div", { class: "card" },
      h("div", { class: "chart-head" }, h("h2", {}, "ยอดขายรายวัน (ชำระสำเร็จ)"), toggle), wrap, table);
  }

  // ---------- payments ----------
  function paymentTable(rows) {
    return h("table", { class: "list" },
      h("thead", {}, h("tr", {}, h("th", {}, "รายการ"), h("th", {}, "ช่องทาง"), h("th", {}, "วันที่"), h("th", {}, "สถานะ"), h("th", { class: "num" }, "ยอดเงิน"))),
      h("tbody", {}, rows.map((p) => h("tr", { tabindex: "0", onclick: () => openPayment(p.id), onkeydown: (e) => { if (e.key === "Enter") openPayment(p.id); } },
        h("td", { class: "c-ref" }, h("span", { class: "ref" }, p.reference || p.description || p.id), h("span", { class: "small muted" }, p.reference && p.description ? p.description : "")),
        h("td", { class: "c-method" }, METHOD[p.method]),
        h("td", { class: "c-date small" }, dt(p.created_at)),
        h("td", { class: "c-status" }, statusBadge(p.status)),
        h("td", { class: "num c-amount" }, baht(p.amount)),
      ))));
  }

  async function loadPayments(more) {
    const params = new URLSearchParams({ limit: "25" });
    if (S.filter) params.set("status", S.filter);
    if (S.q) params.set("q", S.q);
    if (more && S.list.length) params.set("starting_after", S.list[S.list.length - 1].id);
    const res = await api("/payments?" + params);
    S.list = more ? S.list.concat(res.data) : res.data;
    S.hasMore = res.has_more;
  }

  async function viewPayments() {
    const FILTERS = [["", "ทั้งหมด"], ["awaiting_review", "รอตรวจสอบ"], ["pending", "รอชำระ"], ["succeeded", "สำเร็จ"], ["failed", "ไม่สำเร็จ"], ["expired", "หมดอายุ"], ["cancelled", "ยกเลิก"]];
    const listBox = h("div");
    const render = () => {
      listBox.replaceChildren(...[
        S.list.length ? paymentTable(S.list) : h("div", { class: "empty" }, "ไม่พบรายการ"),
        S.hasMore ? h("div", { class: "row center-mt" },
          h("button", { class: "btn", type: "button", onclick: async () => { await loadPayments(true); render(); } }, "โหลดเพิ่ม")) : null,
      ].filter(Boolean));
    };
    const chips = h("div", { class: "chips", role: "group", "aria-label": "กรองสถานะ" }, FILTERS.map(([v, label]) =>
      h("button", { class: "chip", type: "button", "aria-pressed": String(S.filter === v), onclick: async (e) => {
        S.filter = v; chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === e.currentTarget)));
        await loadPayments(false); render();
      } }, label)));
    let timer;
    const search = h("input", { type: "search", placeholder: "ค้นหาเลขอ้างอิง / รายละเอียด / รหัสรายการ", value: S.q, "aria-label": "ค้นหา",
      oninput: () => { clearTimeout(timer); timer = setTimeout(async () => { S.q = search.value.trim(); await loadPayments(false); render(); }, 300); } });
    mainEl.replaceChildren(h("h1", {}, "รายการชำระเงิน"),
      h("div", { class: "card grid" }, h("div", { class: "grid gap12" }, search, chips), listBox));
    await loadPayments(false);
    render();
  }

  // ---------- payment detail drawer ----------
  async function openPayment(id) {
    const scrim = h("div", { class: "scrim" });
    const body = h("div", { class: "body" }, h("p", { class: "muted" }, "กำลังโหลด…"));
    const close = () => { scrim.remove(); drawer.remove(); document.removeEventListener("keydown", onKey); if (slipUrl) URL.revokeObjectURL(slipUrl); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const closeBtn = h("button", { class: "btn", type: "button", onclick: close }, "ปิด");
    const drawer = h("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": "รายละเอียดรายการ" },
      h("header", {}, h("h2", { class: "m0 flex1" }, "รายละเอียดรายการ"), closeBtn), body);
    scrim.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.append(scrim, drawer);
    closeBtn.focus();
    let slipUrl = null;

    const render = async () => {
      const p = await api("/payments/" + encodeURIComponent(id));
      const kids = [
        h("div", {}, h("div", { class: "amount-lg" }, baht(p.amount)), h("div", { class: "row mt6" }, statusBadge(p.status), h("span", { class: "muted small" }, METHOD[p.method]))),
      ];
      if (p.slip_verification) {
        const v = p.slip_verification;
        kids.push(h("div", { class: "verify " + v.status },
          h("strong", {}, VERIFY[v.status] || v.status),
          v.reason ? h("span", {}, reasonText(v.reason)) : null,
          v.trans_ref ? h("div", { class: "small muted" }, "เลขอ้างอิงธนาคาร: " + v.trans_ref) : null,
          v.next_retry_at && p.status === "awaiting_review" ? h("div", { class: "small muted" }, "ตรวจซ้ำอัตโนมัติ " + dt(v.next_retry_at)) : null));
      }
      const actions = [];
      const act = (label, cls, path, body, confirmMsg) => h("button", { class: "btn " + cls, type: "button", onclick: async (e) => {
        let payload = body;
        if (typeof body === "function") { payload = body(); if (!payload) return; }
        else if (confirmMsg && !confirm(confirmMsg)) return;
        e.currentTarget.disabled = true;
        try { await api("/payments/" + encodeURIComponent(id) + "/" + path, { method: "POST", body: payload || {} }); toast("บันทึกแล้ว"); await render(); refreshBackground(); }
        catch (ex) { toast(ex.message); e.currentTarget.disabled = false; }
      } }, label);
      if (p.method !== "card" && (p.status === "awaiting_review" || p.status === "pending")) {
        actions.push(act("ยืนยันว่าได้รับเงินแล้ว", "good", "approve", null, "ยืนยันว่าได้รับเงิน " + baht(p.amount) + " เข้าบัญชีแล้ว?"));
      }
      if (p.status === "awaiting_review") {
        actions.push(act("ปฏิเสธสลิป", "bad", "reject", () => {
          const r = prompt("เหตุผลที่ปฏิเสธ (ลูกค้าและระบบของร้านจะเห็น)", "ไม่พบยอดเงินเข้า");
          return r === null ? null : { reason: r.slice(0, 255) || "rejected_by_merchant" };
        }));
      }
      if (p.status === "pending") actions.push(act("ยกเลิกรายการ", "bad", "cancel", null, "ยกเลิกรายการนี้? ลูกค้าจะชำระไม่ได้อีก"));
      if (actions.length) kids.push(h("div", { class: "actions" }, actions));

      kids.push(h("dl", { class: "kv" },
        h("dt", {}, "รหัสรายการ"), h("dd", {}, p.id),
        h("dt", {}, "เลขอ้างอิง"), h("dd", {}, p.reference || "-"),
        h("dt", {}, "รายละเอียด"), h("dd", {}, p.description || "-"),
        h("dt", {}, "สร้างเมื่อ"), h("dd", {}, dt(p.created_at)),
        h("dt", {}, p.status === "succeeded" ? "ชำระเมื่อ" : "หมดอายุ"), h("dd", {}, dt(p.status === "succeeded" ? p.paid_at : p.expires_at)),
        p.failure_reason ? [h("dt", {}, "เหตุผล"), h("dd", {}, reasonText(p.failure_reason))] : null,
      ));
      if (p.status === "pending") kids.push(h("div", {}, h("h2", {}, "ลิงก์ชำระเงิน"), copyField(p.checkout_url)));

      if (p.has_slip) {
        const slipBox = h("div", {}, h("h2", {}, "สลิป"), h("p", { class: "muted small" }, "กำลังโหลดสลิป…"));
        kids.push(slipBox);
        fetch("/dashboard/api/payments/" + encodeURIComponent(id) + "/slip", { credentials: "same-origin" }).then(async (r) => {
          if (!r.ok) throw new Error();
          const blob = await r.blob();
          if (slipUrl) URL.revokeObjectURL(slipUrl);
          slipUrl = URL.createObjectURL(blob);
          slipBox.replaceChildren(h("h2", {}, "สลิป"), blob.type === "application/pdf"
            ? h("a", { href: slipUrl, target: "_blank", rel: "noopener" }, "เปิดสลิป (PDF)")
            : h("a", { href: slipUrl, target: "_blank", rel: "noopener" }, h("img", { class: "slip-img", src: slipUrl, alt: "สลิปการโอนเงิน" })));
        }).catch(() => slipBox.replaceChildren(h("h2", {}, "สลิป"), h("p", { class: "error" }, "โหลดสลิปไม่ได้")));
      }
      if (p.slip_checks?.length) {
        kids.push(h("div", {}, h("h2", {}, "ประวัติการตรวจสลิป"), h("table", { class: "list" },
          h("thead", {}, h("tr", {}, h("th", {}, "เวลา"), h("th", {}, "ผล"), h("th", {}, "รายละเอียด"))),
          h("tbody", {}, p.slip_checks.map((c) => h("tr", { class: "nocursor" },
            h("td", { class: "small" }, dt(c.created_at)),
            h("td", {}, VERIFY[c.outcome] || c.outcome),
            h("td", { class: "small" }, reasonText(c.reason) || (c.amount != null ? "ยอด " + baht(c.amount) : ""))))))));
      }
      body.replaceChildren(...kids);
    };
    try { await render(); } catch (ex) { body.replaceChildren(h("p", { class: "error" }, ex.message)); }
  }

  function refreshBackground() {
    if (S.tab === "overview") viewOverview().catch(() => {});
    else if (S.tab === "payments") { loadPayments(false).then(() => viewPayments()).catch(() => {}); }
  }

  // ---------- create payment link ----------
  function viewCreate() {
    const m = S.me.merchant;
    const methods = [
      m.promptpay_id ? ["promptpay", "PromptPay QR"] : null,
      m.bank_account ? ["bank_transfer", "โอนเงิน + แนบสลิป"] : null,
      ["card", "บัตรเครดิต/เดบิต"],
    ].filter(Boolean);
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
        const satang = Math.round(Number(amount.value) * 100);
        const p = await api("/payments", { method: "POST", body: {
          amount: satang, method: method.value, description: desc.value || undefined, reference: ref.value || undefined, expires_in: Number(ttl.value) } });
        out.replaceChildren(h("div", { class: "card grid" },
          h("h2", {}, "ลิงก์พร้อมส่งให้ลูกค้า"),
          h("div", { class: "row" }, h("span", { class: "amount-lg" }, baht(p.amount)), statusBadge(p.status)),
          copyField(p.checkout_url),
          p.promptpay ? h("div", {}, h("p", { class: "small muted" }, "หรือให้ลูกค้าสแกน QR นี้ได้เลย (หมดอายุ " + dt(p.expires_at) + ")"),
            h("img", { class: "qr-out", src: p.promptpay.qr_image_url.replace(/^https?:\\/\\/[^/]+/, ""), alt: "PromptPay QR " + baht(p.amount) })) : null,
          h("div", { class: "row" },
            h("a", { class: "btn", href: p.checkout_url, target: "_blank", rel: "noopener" }, "เปิดหน้าชำระเงิน"),
            h("button", { class: "btn", type: "button", onclick: () => openPayment(p.id) }, "ดูรายละเอียด"))));
        form.reset();
      } catch (ex) { err.textContent = ex.message; }
      finally { btn.disabled = false; }
    } },
      h("p", { class: "muted m0" }, "สร้างลิงก์ชำระเงินส่งให้ลูกค้าทาง LINE / แชต ได้เลยโดยไม่ต้องเชื่อม API"),
      h("label", { class: "f" }, "ยอดเงิน (บาท)", amount),
      h("label", { class: "f" }, "ช่องทางชำระ", method),
      h("label", { class: "f" }, "รายละเอียด", desc),
      h("label", { class: "f" }, "เลขอ้างอิง", ref),
      h("label", { class: "f" }, "ลิงก์หมดอายุใน", ttl),
      err, h("div", { class: "row" }, btn));
    mainEl.replaceChildren(h("h1", {}, "สร้างลิงก์ชำระเงิน"), h("div", { class: "grid narrow" }, form, out));
  }

  // ---------- settings ----------
  async function viewSettings() {
    const m = S.me.merchant;
    const secret = h("input", { type: "password", readonly: true, value: S.me.webhook_secret });
    const reveal = h("button", { class: "btn", type: "button", onclick: () => {
      const show = secret.type === "password"; secret.type = show ? "text" : "password"; reveal.textContent = show ? "ซ่อน" : "แสดง";
    } }, "แสดง");
    const deliveries = h("div", {}, h("p", { class: "muted" }, "กำลังโหลด…"));
    mainEl.replaceChildren(h("h1", {}, "ตั้งค่า"), h("div", { class: "grid" },
      h("div", { class: "card" }, h("h2", {}, "ข้อมูลรับเงิน"), h("dl", { class: "kv" },
        h("dt", {}, "ชื่อร้าน"), h("dd", {}, m.name),
        h("dt", {}, "PromptPay"), h("dd", {}, m.promptpay_id || "ยังไม่ได้ตั้งค่า"),
        h("dt", {}, "บัญชีธนาคาร"), h("dd", {}, m.bank_account ? [m.bank_account.bank_name, m.bank_account.account_no, m.bank_account.account_name].filter(Boolean).join(" · ") : "ยังไม่ได้ตั้งค่า"),
        h("dt", {}, "รหัสร้าน"), h("dd", {}, m.id)),
        h("p", { class: "small muted" }, "ต้องการแก้ไขข้อมูลรับเงิน กรุณาติดต่อผู้ดูแลเกตเวย์")),
      h("div", { class: "card grid gap12" }, h("h2", { class: "m0" }, "Webhook"),
        h("dl", { class: "kv" }, h("dt", {}, "URL"), h("dd", {}, m.webhook_url || "ยังไม่ได้ตั้งค่า")),
        h("label", { class: "f" }, "Webhook secret (ใช้ตรวจลายเซ็น Bizhub-Signature)", h("div", { class: "copy-field" }, secret, reveal,
          h("button", { class: "btn", type: "button", onclick: () => navigator.clipboard.writeText(S.me.webhook_secret).then(() => toast("คัดลอกแล้ว")) }, "คัดลอก"))),
        h("h2", { class: "mt8" }, "การส่ง webhook ล่าสุด"), deliveries),
    ));
    const res = await api("/webhooks");
    const ST = { delivered: "ส่งสำเร็จ", pending: "รอส่ง/ส่งซ้ำ", failed: "ล้มเหลว" };
    deliveries.replaceChildren(res.data.length ? h("table", { class: "list" },
      h("thead", {}, h("tr", {}, h("th", {}, "เวลา"), h("th", {}, "เหตุการณ์"), h("th", {}, "ผล"), h("th", { class: "num" }, "ครั้งที่ส่ง"))),
      h("tbody", {}, res.data.map((d) => h("tr", { class: "nocursor" },
        h("td", { class: "small" }, dt(d.created_at)),
        h("td", { class: "small" }, d.event_type),
        h("td", { class: "small" }, (ST[d.status] || d.status) + (d.last_error ? " (" + d.last_error + ")" : "")),
        h("td", { class: "num" }, d.attempts))))) : h("div", { class: "empty" }, m.webhook_url ? "ยังไม่มีการส่ง" : "ยังไม่ได้ตั้งค่า webhook URL"));
  }

  // ---------- boot ----------
  async function boot() {
    try { S.me = await api("/me"); } catch { return showLogin(); }
    S.summary = await api("/summary").catch(() => null);
    go(S.tab);
  }
  // Keep the review badge and overview fresh while the tab is visible.
  setInterval(() => {
    if (!S.me || document.hidden || document.querySelector(".drawer")) return;
    if (S.tab === "overview") viewOverview().catch(() => {});
  }, 30000);
  boot();
})();
</script>
</body>
</html>`;
}
