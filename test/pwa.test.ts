import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGateway } from "./helpers.ts";

test("the dashboard is installable: manifest, icons, service worker and shell tags", async () => {
  const { gw, cleanup } = await makeGateway();
  try {
    const m = await gw.app.inject({ method: "GET", url: "/manifest.webmanifest" });
    assert.equal(m.statusCode, 200);
    assert.match(m.headers["content-type"] as string, /application\/manifest\+json/);
    const manifest = m.json();
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/dashboard");
    for (const size of ["192x192", "512x512"]) assert.ok(manifest.icons.some((i: { sizes: string }) => i.sizes === size), size);
    for (const icon of manifest.icons) assert.equal((await gw.app.inject({ method: "GET", url: icon.src })).statusCode, 200, icon.src);

    const sw = await gw.app.inject({ method: "GET", url: "/sw.js" });
    assert.equal(sw.statusCode, 200);
    assert.match(sw.body, /addEventListener\("fetch"/);
    assert.doesNotMatch(sw.body, /caches\./, "payment pages are never cached");

    const page = await gw.app.inject({ method: "GET", url: "/dashboard" });
    assert.match(page.body, /<link rel="manifest" href="\/manifest.webmanifest">/);
    assert.match(page.body, /apple-touch-icon/);
  } finally {
    await cleanup();
  }
});

test("/install explains installing on each device and links its own script and styles", async () => {
  const { gw, cleanup } = await makeGateway();
  try {
    const r = await gw.app.inject({ method: "GET", url: "/install" });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers["content-security-policy"] as string, /script-src 'self'/);
    for (const text of ["เพิ่มไปยังหน้าจอโฮม", "ติดตั้งแอป", "Android", "iPhone"]) assert.match(r.body, new RegExp(text));
    assert.doesNotMatch(r.body, /<script>(?!<\/script>)/, "no inline script (CSP)");
    for (const asset of ["/assets/install.js", "/assets/install.css"]) assert.equal((await gw.app.inject({ method: "GET", url: asset })).statusCode, 200, asset);
  } finally {
    await cleanup();
  }
});
