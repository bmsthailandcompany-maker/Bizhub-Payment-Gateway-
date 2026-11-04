/**
 * Creates a merchant directly in the database (handy for the first setup).
 * Usage: npm run create-merchant -- --name "My Shop" --promptpay 0812345678 [--webhook https://...]
 */
import { parseArgs } from "node:util";
import { openDb } from "../src/db.ts";
import { createMerchantSchema } from "../src/routes/schemas.ts";
import { MerchantService } from "../src/services/merchants.ts";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    promptpay: { type: "string" },
    "bank-name": { type: "string" },
    "bank-account": { type: "string" },
    "bank-account-name": { type: "string" },
    webhook: { type: "string" },
  },
});

const input = createMerchantSchema.parse({
  name: values.name,
  promptpay_id: values.promptpay,
  bank_name: values["bank-name"],
  bank_account_no: values["bank-account"],
  bank_account_name: values["bank-account-name"],
  webhook_url: values.webhook,
});

const db = openDb(process.env.DATA_DIR ?? "./data");
const { merchant, keys } = new MerchantService(db).create(input);
console.log(JSON.stringify({ merchant_id: merchant.id, webhook_secret: merchant.webhook_secret, ...keys }, null, 2));
console.log("\nเก็บ secret key ไว้ให้ดี — ระบบจะไม่แสดงอีก");
