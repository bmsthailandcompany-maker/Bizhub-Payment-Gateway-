/**
 * Creates an admin console account and prints its one-time password.
 * Usage: npm run create-admin -- --email ops@example.com --name "Ops" [--role superadmin|operator|support]
 */
import { parseArgs } from "node:util";
import { ADMIN_ROLES } from "../src/auth/permissions.ts";
import { openDb } from "../src/db.ts";
import { UserService } from "../src/services/users.ts";

const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string" } } });
const role = values.role ?? "superadmin";
if (!values.email || !values.name || !(role in ADMIN_ROLES)) {
  console.error(`Usage: npm run create-admin -- --email <email> --name <name> [--role ${Object.keys(ADMIN_ROLES).join("|")}]`);
  process.exit(1);
}
const users = new UserService(openDb(process.env.DATA_DIR ?? "./data"));
const { user, temporaryPassword } = await users.create("admin", { email: values.email, name: values.name, role });
console.log(`สร้างบัญชีแอดมิน ${user.email} (${role}) แล้ว`);
console.log(`รหัสผ่านชั่วคราว: ${temporaryPassword}`);
console.log("เข้าสู่ระบบที่ /admin/console แล้วระบบจะให้ตั้งรหัสผ่านใหม่");
