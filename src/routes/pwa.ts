import type { FastifyInstance } from "fastify";

/**
 * Makes the dashboard installable as an app (Chrome/Edge "Install", iOS "Add to Home Screen").
 * Both files live at the site root so the service worker's scope covers /dashboard and /admin/console.
 */
const MANIFEST = {
  id: "/dashboard",
  name: "BIZHUB PAY",
  short_name: "BIZHUB PAY",
  description: "รับชำระเงินและจัดการร้านค้า",
  lang: "th",
  start_url: "/dashboard",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: "#ffffff",
  theme_color: "#0b2a6b",
  icons: [
    { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/assets/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

/**
 * Network only: payment and account data must never be served from a cache. The worker exists so the
 * browser treats the site as an app, and shows a friendly page instead of the browser's error when offline.
 */
const SERVICE_WORKER = `
const OFFLINE = '<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BIZHUB PAY</title></head>' +
  '<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#eff6ff;color:#092752;text-align:center">' +
  '<div><h1 style="font-size:20px">ไม่มีการเชื่อมต่ออินเทอร์เน็ต</h1><p>กรุณาตรวจสอบสัญญาณแล้วลองใหม่</p>' +
  '<button onclick="location.reload()" style="font:inherit;padding:10px 18px;border:0;border-radius:10px;background:#075dcc;color:#fff">ลองใหม่</button></div></body></html>';
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
`;

export async function pwaRoutes(app: FastifyInstance) {
  app.get("/manifest.webmanifest", async (_req, reply) =>
    reply.type("application/manifest+json; charset=utf-8").header("Cache-Control", "no-cache").send(JSON.stringify(MANIFEST)));
  app.get("/sw.js", async (_req, reply) =>
    reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-cache").header("Service-Worker-Allowed", "/").send(SERVICE_WORKER));
}
