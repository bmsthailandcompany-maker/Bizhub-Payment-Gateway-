import type { FastifyInstance } from "fastify";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The line shown wherever a customer hands over a slip: what is collected, why, and whose policy applies. */
export function slipPrivacyNotice(merchant: { name: string; privacy_url: string | null }): string {
  const shopPolicy = merchant.privacy_url
    ? ` · <a href="${esc(merchant.privacy_url)}" target="_blank" rel="noopener">นโยบายความเป็นส่วนตัวของร้าน</a>`
    : "";
  return (
    `เมื่อแนบสลิป ข้อมูลในสลิป (ชื่อผู้โอน เลขบัญชีบางส่วน ยอดเงิน เวลาโอน) จะใช้เพื่อยืนยันการชำระเงินกับ ${esc(merchant.name)} ` +
    `และส่งให้ผู้ให้บริการตรวจสอบสลิปกับธนาคารเท่านั้น${shopPolicy} · <a href="/privacy" target="_blank" rel="noopener">นโยบายของระบบ</a>`
  );
}

/**
 * The gateway's own privacy notice. Each shop is the data controller for its customers;
 * the gateway processes their data on the shop's behalf.
 */
export async function legalRoutes(app: FastifyInstance, opts: { operatorName: string; operatorContact: string | null }) {
  app.get("/privacy", async (_req, reply) => {
    const op = esc(opts.operatorName);
    const contact = opts.operatorContact ? `ติดต่อเรื่องข้อมูลส่วนบุคคลได้ที่ ${esc(opts.operatorContact)}` : "ติดต่อผ่านร้านค้าที่คุณชำระเงินด้วย";
    return reply
      .type("text/html; charset=utf-8")
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      .header("Cache-Control", "public, max-age=3600")
      .send(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>นโยบายความเป็นส่วนตัว · ${op}</title>
<style>body{margin:0;font:16px/1.7 system-ui,"Noto Sans Thai",sans-serif;color:#1d2330;background:#f5f6f8}main{max-width:720px;margin:0 auto;padding:24px 16px}
h1{font-size:24px}h2{font-size:17px;margin-top:28px}@media(prefers-color-scheme:dark){body{background:#0f1218;color:#e8eaf0}}</style></head><body><main>
<h1>นโยบายความเป็นส่วนตัวของระบบรับชำระเงิน</h1>
<p>${op} ให้บริการระบบรับชำระเงินแก่ร้านค้า เมื่อคุณชำระเงินหรือแจ้งชำระเงินผ่านหน้านี้ <b>ร้านค้าที่คุณชำระเงินด้วยเป็นผู้ควบคุมข้อมูลส่วนบุคคล</b> และ ${op} เป็นผู้ประมวลผลข้อมูลแทนร้านค้า ตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562</p>
<h2>ข้อมูลที่เก็บ</h2>
<p>ยอดเงิน เลขอ้างอิงหรือเลขบิลที่คุณกรอก รูปสลิปการโอน และข้อมูลที่อ่านได้จากสลิป ได้แก่ ชื่อผู้โอน เลขบัญชีบางส่วน ธนาคาร เวลาโอน และเลขที่รายการของธนาคาร หากชำระด้วยบัตร ระบบไม่เห็นและไม่เก็บเลขบัตร (ข้อมูลบัตรส่งตรงไปยังผู้ให้บริการบัตร)</p>
<h2>ใช้เพื่ออะไร</h2>
<p>เพื่อยืนยันว่าการชำระเงินเกิดขึ้นจริงและตรงกับรายการของร้านค้า ป้องกันการใช้สลิปซ้ำหรือสลิปปลอม และให้ร้านค้าใช้เป็นหลักฐานการรับชำระเงิน</p>
<h2>ส่งต่อให้ใคร</h2>
<p>ร้านค้าที่คุณชำระเงินด้วย และผู้ให้บริการตรวจสอบสลิปกับระบบธนาคาร ซึ่งใช้ข้อมูลเพื่อการตรวจสอบเท่านั้น ระบบไม่ขายหรือใช้ข้อมูลของคุณเพื่อการตลาด</p>
<h2>เก็บนานเท่าไร</h2>
<p>ตามระยะเวลาที่ร้านค้ากำหนดเพื่อหลักฐานทางบัญชีและภาษี เมื่อพ้นกำหนด ระบบลบรูปสลิปโดยคงไว้เพียงเลขที่รายการของธนาคารเพื่อป้องกันการใช้สลิปซ้ำ</p>
<h2>สิทธิของคุณ</h2>
<p>คุณมีสิทธิขอเข้าถึง ขอแก้ไข ขอลบ หรือคัดค้านการประมวลผลข้อมูลของคุณ โดยติดต่อร้านค้าที่คุณชำระเงินด้วยโดยตรง ${contact}</p>
</main></body></html>`);
  });
}
