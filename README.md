# Bizhub Payment Gateway

เกตเวย์รับชำระเงินแบบหลายร้านค้า (multi-merchant) ร้านค้าเชื่อมต่อผ่าน API แล้วส่งลูกค้าไปจ่ายที่หน้าชำระเงินของเกตเวย์

| ช่องทาง | วิธีทำงาน | ใครยืนยันยอด |
|---|---|---|
| **PromptPay QR** | สร้าง QR ตามยอดเงิน (มาตรฐาน EMVCo / Thai QR) เงินเข้าพร้อมเพย์ของร้านโดยตรง ลูกค้าแนบสลิปหลังโอน | **อัตโนมัติ** ตรวจสลิปกับธนาคาร |
| **บัตรเครดิต/เดบิต** | ข้อมูลบัตรถูกแปลงเป็น token ในเบราว์เซอร์ แล้วตัดเงินผ่าน Omise (Opn Payments) รองรับ 3-D Secure | อัตโนมัติจากผู้ให้บริการบัตร |
| **โอนเงิน + แนบสลิป** | แสดงเลขบัญชีร้าน ลูกค้าโอนแล้วอัปโหลดสลิป | **อัตโนมัติ** ตรวจสลิปกับธนาคาร |

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

## ยืนยันสลิปอัตโนมัติ

เมื่อลูกค้าแนบสลิป ระบบส่งภาพไปให้ผู้ให้บริการตรวจสลิป ([EasySlip](https://easyslip.com) หรือ [SlipOK](https://slipok.com))
อ่าน QR บนสลิปแล้วเช็กกับเครือข่ายธนาคารว่ารายการโอนมีอยู่จริง จากนั้นเกตเวย์ตรวจซ้ำเองทุกข้อก่อนตัดสินว่าจ่ายแล้ว:

| ตรวจ | ไม่ผ่านแล้วเกิดอะไร |
|---|---|
| รายการโอนมีอยู่จริงที่ธนาคาร (กันสลิปปลอม/ตัดต่อ) | ปฏิเสธ ลูกค้าแนบใหม่ได้ |
| ยอดเงินตรงกับยอดที่ต้องชำระ | ยอดขาด → ปฏิเสธ · ยอดเกิน → ส่งให้ร้านค้าตรวจ |
| บัญชีผู้รับเป็นของร้านนี้ (เทียบพร้อมเพย์/เลขบัญชีที่ธนาคารปิดบางหลัก) | ไม่ตรง → ปฏิเสธ · อ่านไม่ได้ → ส่งให้ร้านค้าตรวจ |
| เวลาโอนไม่เก่ากว่าตอนสร้างรายการ (กันเอาสลิปเก่ามาใช้) | ปฏิเสธ |
| สลิปนี้ยังไม่เคยใช้จ่ายรายการอื่น (ทุกร้านในเกตเวย์) | ปฏิเสธ |

ผลลัพธ์มี 3 แบบ:

- **verified**: รายการเป็น `succeeded` ทันที ลูกค้าเห็น "ชำระเงินสำเร็จ" ภายในไม่กี่วินาที และร้านค้าได้ webhook `payment.succeeded`
- **rejected**: รายการยังเป็น `pending` ลูกค้าเห็นเหตุผลเป็นภาษาไทยแล้วแนบใหม่ได้ (ไม่เกิน 5 ครั้งต่อรายการ) ร้านค้าได้ webhook `payment.slip_rejected`
- **needs_review**: เช่น ธนาคารยังไม่อัปเดตรายการ หรือผู้ให้บริการล่ม รายการจะเป็น `awaiting_review` และระบบลองตรวจซ้ำเองเป็นระยะ (สูงสุด 6 ครั้งใน ~4 ชั่วโมง) ถ้ายังตัดสินไม่ได้ ร้านค้า approve/reject เองได้

ตั้งค่าใน `.env`:

```bash
SLIP_VERIFIER=easyslip          # หรือ slipok
EASYSLIP_API_KEY=...            # ถ้าใช้ EasySlip
SLIPOK_BRANCH_ID=... SLIPOK_API_KEY=...   # ถ้าใช้ SlipOK
```

- โหมดทดสอบ (`sk_test_`) ใช้ตัวจำลองเสมอ ภาพใดก็ผ่านด้วยยอดที่ถูกต้อง จึงลองทั้ง flow ได้โดยไม่เสียโควต้า
- ถ้ายังไม่ตั้งค่าผู้ให้บริการ สลิปโหมด live จะรอร้านค้ายืนยันเองเหมือนเดิม
- สลิปไฟล์ PDF ตรวจอัตโนมัติไม่ได้ ระบบจะส่งให้ร้านค้าตรวจ
- ประวัติการตรวจทุกครั้งดูได้ที่ `GET /v1/payments/:id/slip-checks`

## Dashboard ร้านค้า

เปิด `https://<โดเมนเกตเวย์>/dashboard` แล้วเข้าสู่ระบบด้วย Secret key ของร้าน (`sk_test_` = ข้อมูลทดสอบ, `sk_live_` = ข้อมูลจริง)

- **ภาพรวม**: ยอดขายวันนี้ / 14 วัน, กราฟยอดขายรายวัน (ดูเป็นตารางได้), จำนวนรายการที่รอตรวจสอบ
- **รายการชำระเงิน**: ค้นหาตามเลขอ้างอิง/รายละเอียด กรองตามสถานะ กดดูรายละเอียดเพื่อดูสลิป ผลตรวจสลิปอัตโนมัติ และประวัติการตรวจ
  พร้อมปุ่ม **ยืนยันว่าได้รับเงิน / ปฏิเสธสลิป / ยกเลิกรายการ**
- **สร้างลิงก์ชำระเงิน**: กรอกยอดแล้วได้ลิงก์ + QR ส่งให้ลูกค้าทาง LINE ได้ทันที ไม่ต้องเชื่อม API
- **ตั้งค่า**: ข้อมูลรับเงิน, webhook secret และสถานะการส่ง webhook ล่าสุด

ความปลอดภัย: key ใช้แค่ตอนเข้าสู่ระบบ จากนั้นเบราว์เซอร์ถือเพียง session cookie แบบ HttpOnly + SameSite=Strict อายุ 12 ชั่วโมง
session จะหมดอายุทันทีเมื่อแอดมิน rotate key หรือปิดร้าน

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
| `POST` | `/v1/payments/:id/approve` | ยืนยันด้วยมือ (กรณีระบบส่งให้ตรวจ) |
| `POST` | `/v1/payments/:id/reject` | ปฏิเสธสลิป `{"reason": "amount_mismatch"}` |
| `GET` | `/v1/payments/:id/slip` | ดาวน์โหลดสลิปที่ลูกค้าแนบ |
| `GET` | `/v1/payments/:id/slip-checks` | ประวัติการตรวจสลิปอัตโนมัติ |
| `POST` | `/v1/payments/:id/cancel` | ยกเลิกรายการที่ยังไม่จ่าย |
| `POST` | `/v1/payments/:id/simulate` | (เฉพาะ test key) จำลองผล `{"status": "succeeded"}` |
| `GET` | `/v1/merchant` | ข้อมูลร้าน + `webhook_secret` |

### สถานะ

```
pending ──(สลิปผ่าน / บัตรผ่าน)──▶ succeeded
   │──(สลิปไม่ผ่าน)──▶ pending (แนบใหม่ได้)
   ├──(ตรวจยังไม่ได้)──▶ awaiting_review ──(ตรวจซ้ำผ่าน / approve)──▶ succeeded
   │                              └──────reject─────▶ failed
   ├──(เลยเวลา)──▶ expired
   └──(cancel)──▶ cancelled
```

บัตรที่ถูกปฏิเสธจะยังคงเป็น `pending` (เก็บเหตุผลไว้ใน `failure_reason`) ให้ลูกค้าลองบัตรใบอื่นได้จนกว่าจะหมดเวลา

## Webhook

เหตุการณ์: `payment.created`, `payment.awaiting_review`, `payment.slip_rejected`, `payment.succeeded`, `payment.failed`, `payment.expired`, `payment.cancelled`

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
  services/              merchants, payments (state machine), slips (ตรวจสลิป), webhooks
  slip/                  ตัวเชื่อม EasySlip / SlipOK + กฎตรวจสลิป
  routes/                merchant API, admin API, หน้า checkout, dashboard
test/                    ชุดทดสอบ (node:test)
```

## ก่อนขึ้นระบบจริง

- รันหลัง HTTPS (reverse proxy เช่น Nginx/Caddy) และตั้ง `PUBLIC_BASE_URL` เป็นโดเมนจริง
- สำรองโฟลเดอร์ `DATA_DIR` (ฐานข้อมูล + สลิป) สม่ำเสมอ ถ้าปริมาณสูงควรย้ายไป PostgreSQL และเก็บสลิปบน object storage
- ใส่ rate limit สำหรับ `/checkout/*` ที่ reverse proxy
- สมัครผู้ให้บริการตรวจสลิปและตั้ง `SLIP_VERIFIER` เพื่อเปิดการยืนยันอัตโนมัติในโหมด live
- ลูกค้าที่จ่าย PromptPay แล้วไม่แนบสลิป ระบบจะยังไม่รู้ว่าจ่ายแล้ว ถ้าต้องการยืนยันโดยไม่ต้องใช้สลิปเลย ต้องใช้ API แจ้งยอดเข้าของธนาคาร (เช่น KBank / SCB Open API) ซึ่งต้องทำสัญญากับธนาคาร
- การรับเงินแทนร้านค้า (พักเงินไว้ที่เกตเวย์) อาจต้องได้รับอนุญาตจาก ธปท. ระบบนี้จึงออกแบบให้เงินเข้าบัญชีร้านค้าโดยตรง
