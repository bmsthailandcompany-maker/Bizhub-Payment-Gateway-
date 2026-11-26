/* /install: pick the visitor's device tab, offer one-tap install where the browser allows it. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const inApp = /Line\/|FBAN|FBAV|FB_IAB|Instagram|Messenger|MicroMessenger/i.test(ua);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  const show = (tab) => {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  };
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  show(isIOS ? "ios" : isAndroid ? "android" : "desktop");

  if (standalone) $("#installed").hidden = false;
  if (inApp && !standalone) {
    $("#inapp").hidden = false;
    // Android in-app browsers: hand the page to Chrome via an intent link (LINE also honours openExternalBrowser=1).
    if (isAndroid && !/Line\//.test(ua)) $("#open-external").href = "intent://" + location.host + "/install#Intent;scheme=https;end";
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  // Chrome / Edge / Samsung Internet fire this when the app can be installed with one tap.
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    if (!standalone && !inApp) $("#quick").hidden = false;
  });
  $("#install-btn").addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    $("#install-msg").textContent = outcome === "accepted" ? "กำลังติดตั้ง… ไอคอนจะขึ้นบนหน้าจอในไม่กี่วินาที" : "ยกเลิกแล้ว กดติดตั้งใหม่ได้จากเมนูของเบราว์เซอร์ตามขั้นตอนด้านล่าง";
    if (outcome === "accepted") $("#install-btn").disabled = true;
  });
  window.addEventListener("appinstalled", () => { $("#quick").hidden = true; $("#installed").hidden = false; });
})();
