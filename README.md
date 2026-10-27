# Bizhub Payment Gateway

เกตเวย์รับชำระเงินแบบหลายร้านค้า (multi-merchant) ร้านค้าเชื่อมต่อผ่าน API แล้วส่งลูกค้าไปจ่ายที่หน้าชำระเงินของเกตเวย์

| ช่องทาง | วิธีทำงาน | ใครยืนยันยอด |
|---|---|---|
| **PromptPay QR** | สร้าง QR ตามยอดเงิน (มาตรฐาน EMVCo / Thai QR) เงินเข้าพร้อมเพย์ของร้านโดยตรง | ร้านค้า (ดูสลิป/ยอดเข้า แล้วกด approve) |
| **บัตรเครดิต/เดบิต** | ข้อมูลบัตรถูกแปลงเป็น token ในเบราว์เซอร์ แล้วตัดเงินผ่าน Omise (Opn Payments) รองรับ 3-D Secure | อัตโนมัติจากผู้ให้บริการบัตร |
| **โอนเงิน + แนบสลิป** | แสดงเลขบัญชีร้าน ลูกค้าโอนแล้วอัปโหลดสลิป | ร้านค้า (approve / reject) |

ทุกการเปลี่ยนสถานะจะส่ง **webhook ที่เซ็นด้วย HMAC-SHA256** ไปยังร้านค้า พร้อม retry อัตโนมัติ

## เริ่มใช้งาน

ต้องใช้ Node.js 22.13 ขึ้นไป (ใช้ SQLite ที่มากับ Node ไม่ต้องติดตั้งฐานข้อมูลเพิ่ม)

```bash
npm install
cp .env.example .env        # แก้ ADMIN_TOKEN ให้เป็นค่าสุ่มยาว ๆ
export $(grep -v '^#' .env | xargs)
npm run dev                 # http://localhost:3000
npm test                    # รันชุดทดสอบ
```

### สร้างร้านค้า

```bash
curl -X POST http://localhost:3000/admin/merchants \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "ร้านกาแฟบ้านสวน",
    "promptpay_id": "0812345678",
    "bank_name": "กสิกรไทย",
    "bank_account_no": "123-4-56789-0",
    "bank_account_name": "บจก. บ้านสวน",
    "webhook_url": "https://shop.example.com/webhooks/bizhub"
  }'
```

ผลลัพธ์จะมี `test_secret_key`, `live_secret_key` และ `webhook_secret` ซึ่ง**แสดงครั้งเดียว** ให้ส่งให้ร้านค้าเก็บไว้
(หรือใช้ `npm run create-merchant -- --name "..." --promptpay 0812345678`)

## API สำหรับร้านค้า

ยืนยันตัวตนด้วย `Authorization: Bearer sk_test_...` (ทดสอบ) หรือ `sk_live_...` (ใช้งานจริง) ข้อมูลทดสอบกับข้อมูลจริงแยกจากกันเด็ดขาด
จำนวนเงินเป็น **สตางค์** เสมอ (`25000` = 250.00 บาท)

### สร้างรายการชำระเงิน

```bash
curl -X POST http://localhost:3000/v1/payments \
  -H "Authorization: Bearer sk_test_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1001" \
  -d '{"amount": 25000, "method": "promptpay", "reference": "INV-1001",
       "description": "ลาเต้เย็น x2", "return_url": "https://shop.example.com/thanks"}'
```

```json
{
  "id": "pay_h0ZFryINk0eHB7Aw1aW3CRXA",
  "status": "pending",
  "amount": 25000,
  "method": "promptpay",
  "checkout_url": "http://localhost:3000/checkout/pay_h0ZF...",
  "promptpay": { "payload": "000201010212...", "qr_image_url": ".../qr.png" },
  "expires_at": "2026-10-27T10:15:00.000Z"
}
```

ส่งลูกค้าไปที่ `checkout_url` หรือจะนำ `promptpay.payload` ไปสร้าง QR ในแอปตัวเองก็ได้
เมื่อจบรายการ หน้าชำระเงินจะพาลูกค้ากลับไปที่ `return_url?payment_id=...&status=...`
(อย่าเชื่อพารามิเตอร์นี้อย่างเดียว ให้ยืนยันจาก webhook หรือ `GET /v1/payments/:id`)

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| `POST` | `/v1/payments` | สร้างรายการ (`method`: `promptpay` / `card` / `bank_transfer`, `expires_in` เป็นวินาที) |
| `GET` | `/v1/payments` | รายการทั้งหมด (`status`, `reference`, `limit`, `starting_after`) |
| `GET` | `/v1/payments/:id` | ดูรายการ |
| `POST` | `/v1/payments/:id/approve` | ยืนยันว่าได้รับเงินแล้ว (PromptPay / โอนเงิน) |
| `POST` | `/v1/payments/:id/reject` | ปฏิเสธสลิป `{"reason": "amount_mismatch"}` |
| `GET` | `/v1/payments/:id/slip` | ดาวน์โหลดสลิปที่ลูกค้าแนบ |
| `POST` | `/v1/payments/:id/cancel` | ยกเลิกรายการที่ยังไม่จ่าย |
| `POST` | `/v1/payments/:id/simulate` | (เฉพาะ test key) จำลองผล `{"status": "succeeded"}` |
| `GET` | `/v1/merchant` | ข้อมูลร้าน + `webhook_secret` |

### สถานะ

```
pending ──(แนบสลิป)──▶ awaiting_review ──approve──▶ succeeded
   │                         └──────reject─────▶ failed
   ├──(บัตรผ่าน / approve)──▶ succeeded
   ├──(เลยเวลา)──▶ expired
   └──(cancel)──▶ cancelled
```

บัตรที่ถูกปฏิเสธจะยังคงเป็น `pending` (เก็บเหตุผลไว้ใน `failure_reason`) ให้ลูกค้าลองบัตรใบอื่นได้จนกว่าจะหมดเวลา

## Webhook

เหตุการณ์: `payment.created`, `payment.awaiting_review`, `payment.succeeded`, `payment.failed`, `payment.expired`, `payment.cancelled`

```json
{ "id": "evt_...", "object": "event", "type": "payment.succeeded", "created_at": "...", "data": { "...": "payment" } }
```

ทุกคำขอมี header `Bizhub-Signature: t=<unix>,v1=<hex>` โดย `v1 = HMAC_SHA256(webhook_secret, "<t>.<raw body>")`
ร้านค้าต้องตอบ 2xx ภายใน 10 วินาที ไม่เช่นนั้นระบบจะส่งใหม่ที่ 1 นาที, 5 นาที, 30 นาที, 2, 6, 12 และ 24 ชั่วโมง

ตัวอย่างการตรวจลายเซ็น (Node.js):

```js
import crypto from "node:crypto";

function verify(rawBody, header, secret, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return expected.length === v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

webhook อาจถูกส่งซ้ำได้ ให้ใช้ `id` ของ event กันการประมวลผลซ้ำ

## บัตรเครดิต

- **โหมดทดสอบ** ไม่ต้องตั้งค่าอะไร: `4242 4242 4242 4242` = สำเร็จ, `4000 0000 0000 0002` = ถูกปฏิเสธ
- **โหมดจริง** ตั้ง `OMISE_PUBLIC_KEY` และ `OMISE_SECRET_KEY` จากบัญชี Opn Payments
  หน้าชำระเงินใช้ Omise.js แปลงบัตรเป็น token ในเบราว์เซอร์ เกตเวย์จึงไม่เคยเห็นเลขบัตร
- ผู้ให้บริการอื่น (2C2P, GB Prime Pay, Stripe) เพิ่มได้โดยเขียนคลาสตาม `CardProvider` ใน `src/providers/card.ts`

## Admin API

ใช้ `Authorization: Bearer $ADMIN_TOKEN`

| Method | Path | |
|---|---|---|
| `POST` | `/admin/merchants` | สร้างร้านค้า |
| `GET` / `PATCH` | `/admin/merchants[/:id]` | ดู / แก้ไข / ปิดร้าน (`{"active": false}`) |
| `POST` | `/admin/merchants/:id/rotate-keys` | ยกเลิก key เดิมและออก key ใหม่ |
| `POST` | `/admin/merchants/:id/rotate-webhook-secret` | เปลี่ยน webhook secret |
| `GET` | `/admin/payments` | รายการของทุกร้าน (`merchant_id`, `status`) |
| `GET` | `/admin/webhook-deliveries` | สถานะการส่ง webhook |
| `POST` | `/admin/webhook-deliveries/:id/retry` | ส่ง webhook ใหม่ทันที |

## โครงสร้างโค้ด

```
src/
  app.ts                 ประกอบ Fastify + services
  server.ts              entry point + background jobs (หมดอายุ, ส่ง webhook)
  promptpay.ts           สร้าง payload PromptPay QR + CRC16
  db.ts                  SQLite schema
  providers/card.ts      Mock + Omise card provider
  services/              merchants, payments (state machine), webhooks
  routes/                merchant API, admin API, หน้า checkout
test/                    ชุดทดสอบ (node:test)
```

## ก่อนขึ้นระบบจริง

- รันหลัง HTTPS (reverse proxy เช่น Nginx/Caddy) และตั้ง `PUBLIC_BASE_URL` เป็นโดเมนจริง
- สำรองโฟลเดอร์ `DATA_DIR` (ฐานข้อมูล + สลิป) สม่ำเสมอ ถ้าปริมาณสูงควรย้ายไป PostgreSQL และเก็บสลิปบน object storage
- ใส่ rate limit สำหรับ `/checkout/*` ที่ reverse proxy
- PromptPay และการโอนเงินยังยืนยันด้วยมือ หากต้องการยืนยันอัตโนมัติ ต่อยอดได้ด้วย API ตรวจสลิป (เช่น SlipOK, EasySlip) หรือ API แจ้งยอดเข้าของธนาคาร
- การรับเงินแทนร้านค้า (พักเงินไว้ที่เกตเวย์) อาจต้องได้รับอนุญาตจาก ธปท. ระบบนี้จึงออกแบบให้เงินเข้าบัญชีร้านค้าโดยตรง
