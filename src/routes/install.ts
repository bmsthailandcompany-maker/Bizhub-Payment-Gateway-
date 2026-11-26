import type { FastifyInstance } from "fastify";
import { pageHeaders } from "./web-session.ts";

/**
 * /install: how to put BIZHUB PAY on a phone's home screen. Shops get this link from us.
 * The page shows the steps for the visitor's own device (install.js picks the tab) and,
 * where the browser allows it, a one-tap install button.
 */
const STEP = (n: number, html: string) => `<li><span class="n">${n}</span><div>${html}</div></li>`;

const PAGE = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ติดตั้งแอป BIZHUB PAY</title>
<meta name="description" content="ติดตั้ง BIZHUB PAY ลงหน้าจอมือถือ ใช้งานเต็มจอเหมือนแอป ไม่ต้องโหลดจาก Store">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0b2a6b">
<link rel="icon" href="/assets/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="stylesheet" href="/assets/install.css">
</head>
<body>
<main>
  <header class="hero">
    <img src="/assets/icon-192.png" alt="" width="88" height="88">
    <h1>ติดตั้งแอป BIZHUB PAY</h1>
    <p>ใช้งานเต็มจอเหมือนแอปทั่วไป มีไอคอนบนหน้าจอ ไม่ต้องโหลดจาก Store และอัปเดตให้อัตโนมัติ</p>
  </header>

  <section id="installed" class="card ok" hidden>
    <h2>✓ ติดตั้งแล้ว</h2>
    <p>คุณกำลังใช้งานแอป BIZHUB PAY อยู่</p>
    <a class="btn" href="/dashboard">ไปที่หน้าร้านค้า</a>
  </section>

  <section id="inapp" class="card warn" hidden>
    <h2>เปิดในเบราว์เซอร์ก่อน</h2>
    <p>แอป LINE / Facebook / Messenger ติดตั้งแอปไม่ได้ กรุณาเปิดหน้านี้ใน <b>Chrome</b> (Android) หรือ <b>Safari</b> (iPhone)</p>
    <a class="btn" id="open-external" href="/install?openExternalBrowser=1">เปิดในเบราว์เซอร์</a>
    <p class="small">ถ้าปุ่มไม่ทำงาน: กดเมนู <b>⋯</b> มุมขวาบน แล้วเลือก "เปิดในเบราว์เซอร์"</p>
  </section>

  <section id="quick" class="card" hidden>
    <h2>ติดตั้งได้ทันที</h2>
    <button class="btn big" id="install-btn" type="button">⬇ ติดตั้งแอป</button>
    <p class="small" id="install-msg"></p>
  </section>

  <nav class="tabs" role="tablist" aria-label="เลือกอุปกรณ์">
    <button type="button" role="tab" data-tab="android">Android</button>
    <button type="button" role="tab" data-tab="ios">iPhone / iPad</button>
    <button type="button" role="tab" data-tab="desktop">คอมพิวเตอร์</button>
  </nav>

  <section class="card panel" data-panel="android">
    <h2>Android (Chrome / Edge / Samsung Internet)</h2>
    <ol class="steps">
      ${STEP(1, "เปิด <b>www.bizhubpay.com</b> ใน Chrome หรือ Edge")}
      ${STEP(2, "กดเมนู <b>⋮</b> (Chrome) หรือ <b>☰</b> (Edge) ที่มุมจอ")}
      ${STEP(3, "เลือก <b>ติดตั้งแอป</b> หรือ <b>เพิ่มลงในหน้าจอหลัก</b>")}
      ${STEP(4, "กด <b>ติดตั้ง</b> ไอคอน BIZHUB PAY จะอยู่บนหน้าจอและในลิ้นชักแอป")}
    </ol>
    <p class="small">Samsung Internet: กด <b>☰</b> → <b>เพิ่มหน้าไปยัง</b> → <b>หน้าจอหลัก</b></p>
  </section>

  <section class="card panel" data-panel="ios">
    <h2>iPhone / iPad</h2>
    <ol class="steps">
      ${STEP(1, "เปิด <b>www.bizhubpay.com</b> ใน <b>Safari</b>")}
      ${STEP(2, "กดปุ่ม <b>แชร์</b> <span class=\"ico\" aria-label=\"ปุ่มแชร์\">⬆︎</span> ที่แถบล่าง (iPad อยู่มุมขวาบน)")}
      ${STEP(3, "เลื่อนลงแล้วกด <b>เพิ่มไปยังหน้าจอโฮม</b> <span class=\"ico\" aria-hidden=\"true\">＋</span>")}
      ${STEP(4, "กด <b>เพิ่ม</b> ที่มุมขวาบน ไอคอน BIZHUB PAY จะอยู่บนหน้าจอโฮม")}
    </ol>
    <p class="small">ถ้าไม่เห็นเมนู "เพิ่มไปยังหน้าจอโฮม" ให้กด <b>แก้ไขการทำงาน</b> ท้ายรายการแล้วเพิ่มเข้ามา<br>บน iOS 16.4 ขึ้นไปทำจาก Chrome หรือ Edge ได้ด้วย ผ่านปุ่มแชร์เหมือนกัน</p>
  </section>

  <section class="card panel" data-panel="desktop">
    <h2>คอมพิวเตอร์ (Chrome / Edge)</h2>
    <ol class="steps">
      ${STEP(1, "เปิด <b>www.bizhubpay.com</b> ใน Chrome หรือ Edge")}
      ${STEP(2, "กดไอคอน <b>ติดตั้ง</b> <span class=\"ico\" aria-hidden=\"true\">⊕</span> ท้ายช่อง URL หรือเมนู <b>⋮</b> → <b>ติดตั้ง BIZHUB PAY</b>")}
      ${STEP(3, "แอปจะเปิดเป็นหน้าต่างแยก และมีไอคอนใน Start menu / Dock")}
    </ol>
  </section>

  <section class="card faq">
    <h2>คำถามที่พบบ่อย</h2>
    <details><summary>ต้องโหลดจาก Play Store / App Store ไหม?</summary><p>ไม่ต้อง ติดตั้งจากหน้าเว็บได้เลย ใช้พื้นที่น้อยมาก และได้ระบบเวอร์ชันล่าสุดทุกครั้งที่เปิด</p></details>
    <details><summary>ข้อมูลการเงินเก็บอยู่ในมือถือไหม?</summary><p>ไม่เก็บ ทุกข้อมูลดึงจากเซิร์ฟเวอร์ที่เข้ารหัส (HTTPS) ทุกครั้ง ถ้ามือถือหายให้เปลี่ยนรหัสผ่านและเปิดยืนยันตัวตน 2 ชั้น</p></details>
    <details><summary>ไม่มีเมนูติดตั้งขึ้นมา</summary><p>ลองรีเฟรชหน้า 1 ครั้ง ตรวจว่าไม่ได้เปิดในแอป LINE / Facebook และไม่ได้อยู่ในโหมดไม่ระบุตัวตน (Incognito)</p></details>
    <details><summary>ลบแอปอย่างไร?</summary><p>กดค้างที่ไอคอน แล้วเลือก ลบ / ถอนการติดตั้ง เหมือนแอปทั่วไป</p></details>
  </section>

  <p class="foot"><a href="/dashboard">เข้าสู่ระบบ BIZHUB PAY →</a></p>
</main>
<script src="/assets/install.js"></script>
</body>
</html>`;

export async function installRoutes(app: FastifyInstance) {
  app.get("/install", async (_req, reply) => pageHeaders(reply).send(PAGE));
}
