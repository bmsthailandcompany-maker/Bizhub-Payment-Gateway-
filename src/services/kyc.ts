import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.ts";
import { now, tx } from "../db.ts";
import { newId, randomToken } from "../ids.ts";
import { isValidPromptPayId } from "../promptpay.ts";
import type { MerchantRow, MerchantService } from "./merchants.ts";
import { PaymentError, SLIP_MIME_TYPES } from "./payments.ts";
import type { Actor } from "./sessions.ts";
import type { UserService } from "./users.ts";

export const KYC_DOCUMENT_KINDS = {
  id_card: "บัตรประชาชนของเจ้าของ / ผู้มีอำนาจลงนาม",
  company_cert: "หนังสือรับรองบริษัท (นิติบุคคล)",
  bank_book: "หน้าสมุดบัญชีที่ใช้รับเงิน",
  other: "เอกสารอื่น ๆ",
} as const;
export type KycDocumentKind = keyof typeof KYC_DOCUMENT_KINDS;

export interface KycDocumentRow {
  id: string;
  merchant_id: string;
  kind: KycDocumentKind;
  filename: string;
  mime: string;
  path: string;
  size: number;
  created_at: string;
}

export interface KycProfile {
  name?: string;
  business_type?: "individual" | "company";
  tax_id?: string;
  contact_name?: string;
  contact_phone?: string;
  promptpay_id?: string | null;
  bank_name?: string | null;
  bank_account_no?: string | null;
  bank_account_name?: string | null;
}

const MAX_DOCUMENTS = 10;
const EDITABLE: MerchantRow["kyc_status"][] = ["draft", "rejected"];

/** What still blocks a shop from submitting for review, in Thai, for the dashboard checklist. */
export function kycMissing(m: MerchantRow, docs: { kind: string }[]): string[] {
  const missing: string[] = [];
  if (!m.business_type) missing.push("เลือกประเภทผู้ประกอบการ");
  if (!m.tax_id || !/^\d{13}$/.test(m.tax_id)) missing.push("เลขประจำตัวผู้เสียภาษี / เลขบัตรประชาชน 13 หลัก");
  if (!m.contact_name) missing.push("ชื่อผู้ติดต่อ");
  if (!m.contact_phone) missing.push("เบอร์โทรผู้ติดต่อ");
  if (!m.promptpay_id && !m.bank_account_no) missing.push("บัญชีรับเงิน (พร้อมเพย์หรือบัญชีธนาคาร)");
  const kinds = new Set(docs.map((d) => d.kind));
  if (!kinds.has("id_card")) missing.push("เอกสาร: " + KYC_DOCUMENT_KINDS.id_card);
  if (!kinds.has("bank_book")) missing.push("เอกสาร: " + KYC_DOCUMENT_KINDS.bank_book);
  if (m.business_type === "company" && !kinds.has("company_cert")) missing.push("เอกสาร: " + KYC_DOCUMENT_KINDS.company_cert);
  return missing;
}

/**
 * Self sign-up and know-your-customer review. A new shop works in test mode straight away,
 * fills in its details and documents, and opens live mode only after an admin approves it.
 * Receiving accounts are editable by the shop only until approval, so a hijacked shop account
 * cannot quietly redirect customers' money.
 */
export class KycService {
  constructor(
    private readonly db: Db,
    private readonly merchants: MerchantService,
    private readonly users: UserService,
    private readonly dataDir: string,
  ) {}

  private dir(merchantId: string): string {
    return path.join(this.dataDir, "kyc", merchantId);
  }

  async signup(input: { business_name: string; contact_name: string; email: string; phone: string; password: string }) {
    if (this.users.findByEmail("merchant", input.email)) throw new PaymentError(409, "email_taken", "อีเมลนี้มีบัญชีอยู่แล้ว กรุณาเข้าสู่ระบบ");
    const { merchant } = this.merchants.create({ name: input.business_name });
    this.db
      .prepare("UPDATE merchants SET kyc_status = 'draft', contact_name = ?, contact_phone = ? WHERE id = ?")
      .run(input.contact_name, input.phone, merchant.id);
    try {
      const { user } = await this.users.create("merchant", {
        merchantId: merchant.id,
        email: input.email,
        name: input.contact_name,
        role: "owner",
        password: input.password,
      });
      return { merchant: this.merchants.get(merchant.id)!, user };
    } catch (err) {
      // Do not leave a shop without an owner behind (weak password, e-mail taken in a race).
      this.db.prepare("DELETE FROM api_keys WHERE merchant_id = ?").run(merchant.id);
      this.db.prepare("DELETE FROM merchants WHERE id = ?").run(merchant.id);
      throw err;
    }
  }

  private editable(m: MerchantRow): void {
    if (!EDITABLE.includes(m.kyc_status)) {
      throw new PaymentError(409, "kyc_locked", m.kyc_status === "submitted" ? "ส่งตรวจแล้ว กรุณารอผลการตรวจ" : "ร้านผ่านการตรวจแล้ว การแก้ไขข้อมูลรับเงินต้องติดต่อผู้ดูแลระบบ");
    }
  }

  updateProfile(m: MerchantRow, p: KycProfile): MerchantRow {
    this.editable(m);
    if (p.promptpay_id && !isValidPromptPayId(p.promptpay_id)) throw new PaymentError(400, "invalid_promptpay", "เลขพร้อมเพย์ไม่ถูกต้อง");
    if (p.tax_id !== undefined && p.tax_id !== "" && !/^\d{13}$/.test(p.tax_id.replace(/\D/g, ""))) {
      throw new PaymentError(400, "invalid_tax_id", "เลขประจำตัวผู้เสียภาษี / เลขบัตรประชาชนต้องมี 13 หลัก");
    }
    tx(this.db, () => {
      this.merchants.update(m.id, {
        name: p.name ?? m.name,
        promptpay_id: p.promptpay_id === undefined ? m.promptpay_id : p.promptpay_id || null,
        bank_name: p.bank_name === undefined ? m.bank_name : p.bank_name || null,
        bank_account_no: p.bank_account_no === undefined ? m.bank_account_no : p.bank_account_no || null,
        bank_account_name: p.bank_account_name === undefined ? m.bank_account_name : p.bank_account_name || null,
      });
      this.db
        .prepare("UPDATE merchants SET business_type = ?, tax_id = ?, contact_name = ?, contact_phone = ? WHERE id = ?")
        .run(
          p.business_type ?? m.business_type,
          p.tax_id === undefined ? m.tax_id : p.tax_id.replace(/\D/g, "") || null,
          p.contact_name ?? m.contact_name,
          p.contact_phone ?? m.contact_phone,
          m.id,
        );
    });
    return this.merchants.get(m.id)!;
  }

  documents(merchantId: string): KycDocumentRow[] {
    return this.db
      .prepare("SELECT * FROM kyc_documents WHERE merchant_id = ? ORDER BY created_at")
      .all(merchantId) as unknown as KycDocumentRow[];
  }

  addDocument(m: MerchantRow, kind: KycDocumentKind, filename: string, mime: string, data: Buffer): KycDocumentRow {
    this.editable(m);
    const ext = SLIP_MIME_TYPES[mime];
    if (!ext) throw new PaymentError(400, "invalid_file", "รองรับเฉพาะไฟล์ JPG, PNG, WebP หรือ PDF");
    if (this.documents(m.id).length >= MAX_DOCUMENTS) throw new PaymentError(409, "too_many_documents", `แนบเอกสารได้สูงสุด ${MAX_DOCUMENTS} ไฟล์`);
    const id = newId("doc");
    const file = `${id}-${randomToken(8)}${ext}`;
    fs.mkdirSync(this.dir(m.id), { recursive: true });
    fs.writeFileSync(path.join(this.dir(m.id), file), data);
    this.db
      .prepare("INSERT INTO kyc_documents (id, merchant_id, kind, filename, mime, path, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, m.id, kind, filename.slice(0, 120) || "document", mime, file, data.length, now());
    return this.db.prepare("SELECT * FROM kyc_documents WHERE id = ?").get(id) as unknown as KycDocumentRow;
  }

  document(merchantId: string, docId: string): { row: KycDocumentRow; data: Buffer } {
    const row = this.db.prepare("SELECT * FROM kyc_documents WHERE id = ? AND merchant_id = ?").get(docId, merchantId) as
      | KycDocumentRow
      | undefined;
    if (!row) throw new PaymentError(404, "not_found", "ไม่พบเอกสาร");
    return { row, data: fs.readFileSync(path.join(this.dir(merchantId), path.basename(row.path))) };
  }

  removeDocument(m: MerchantRow, docId: string): void {
    this.editable(m);
    const { row } = this.document(m.id, docId);
    fs.rmSync(path.join(this.dir(m.id), path.basename(row.path)), { force: true });
    this.db.prepare("DELETE FROM kyc_documents WHERE id = ?").run(row.id);
  }

  submit(m: MerchantRow): MerchantRow {
    this.editable(m);
    const missing = kycMissing(m, this.documents(m.id));
    if (missing.length) throw new PaymentError(400, "kyc_incomplete", "ยังขาด: " + missing.join(", "));
    this.db.prepare("UPDATE merchants SET kyc_status = 'submitted', kyc_submitted_at = ?, kyc_note = NULL WHERE id = ?").run(now(), m.id);
    return this.merchants.get(m.id)!;
  }

  review(m: MerchantRow, decision: "approve" | "reject", note: string | null, actor: Actor): MerchantRow {
    if (m.kyc_status !== "submitted") throw new PaymentError(409, "kyc_not_submitted", "ร้านนี้ยังไม่ได้ส่งเอกสารให้ตรวจ");
    if (decision === "reject" && !note) throw new PaymentError(400, "note_required", "กรุณาระบุเหตุผลที่ไม่อนุมัติ เพื่อให้ร้านแก้ไขได้");
    this.db
      .prepare("UPDATE merchants SET kyc_status = ?, kyc_note = ?, kyc_reviewed_at = ?, kyc_reviewed_by = ? WHERE id = ?")
      .run(decision === "approve" ? "approved" : "rejected", note, now(), actor.name, m.id);
    return this.merchants.get(m.id)!;
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM merchants WHERE kyc_status = 'submitted'").get() as { n: number }).n;
  }
}
