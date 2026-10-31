/** Every action the dashboards guard. Routes declare which one they need; roles grant sets of them. */
export const MERCHANT_PERMISSIONS = [
  "payments.view",
  "payments.create",
  "payments.review", // approve / reject slips
  "payments.cancel",
  "payments.export",
  "settings.view",
  "webhooks.secret",
  "users.manage",
  "audit.view",
  "bank.manage", // link the shop's bank account for incoming-money notifications
  "billing.view", // the shop's plan, usage and invoices from the gateway operator
] as const;
export type MerchantPermission = (typeof MERCHANT_PERMISSIONS)[number];

export const MERCHANT_ROLES = {
  owner: { label: "เจ้าของร้าน", permissions: [...MERCHANT_PERMISSIONS] },
  manager: {
    label: "ผู้จัดการ",
    permissions: ["payments.view", "payments.create", "payments.review", "payments.cancel", "payments.export", "settings.view", "audit.view", "billing.view"],
  },
  cashier: { label: "แคชเชียร์", permissions: ["payments.view", "payments.create", "payments.review"] },
  accountant: { label: "ฝ่ายบัญชี", permissions: ["payments.view", "payments.export", "billing.view"] },
} satisfies Record<string, { label: string; permissions: MerchantPermission[] }>;
export type MerchantRole = keyof typeof MERCHANT_ROLES;

export const ADMIN_PERMISSIONS = [
  "merchants.view",
  "merchants.manage", // create / edit / deactivate merchants, rotate keys
  "merchant_users.manage",
  "payments.view",
  "payments.review",
  "payments.export",
  "webhooks.manage",
  "admins.manage",
  "audit.view",
  "billing.manage", // plans, assigning plans, issuing and settling invoices
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export const ADMIN_ROLES = {
  superadmin: { label: "ผู้ดูแลสูงสุด", permissions: [...ADMIN_PERMISSIONS] },
  operator: {
    label: "เจ้าหน้าที่ปฏิบัติการ",
    permissions: ["merchants.view", "merchants.manage", "merchant_users.manage", "payments.view", "payments.review", "payments.export", "webhooks.manage", "audit.view", "billing.manage"],
  },
  support: { label: "ฝ่ายบริการลูกค้า", permissions: ["merchants.view", "payments.view"] },
} satisfies Record<string, { label: string; permissions: AdminPermission[] }>;
export type AdminRole = keyof typeof ADMIN_ROLES;

export function merchantCan(role: MerchantRole, perm: MerchantPermission): boolean {
  return (MERCHANT_ROLES[role]?.permissions as readonly string[] | undefined)?.includes(perm) ?? false;
}

export function adminCan(role: AdminRole, perm: AdminPermission): boolean {
  return (ADMIN_ROLES[role]?.permissions as readonly string[] | undefined)?.includes(perm) ?? false;
}
