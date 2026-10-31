import zlib from "node:zlib";
import type { PaymentRow } from "./payments.ts";

/** Maximum rows in one export; larger ranges should be split by date. */
export const MAX_EXPORT_ROWS = 50_000;

export type Cell = string | number | null;

const STATUS_TH: Record<string, string> = {
  pending: "รอชำระ",
  awaiting_review: "รอตรวจสอบ",
  succeeded: "สำเร็จ",
  failed: "ไม่สำเร็จ",
  expired: "หมดอายุ",
  cancelled: "ยกเลิก",
};
const METHOD_TH: Record<string, string> = { promptpay: "PromptPay", card: "บัตร", bank_transfer: "โอนเงิน" };
const VERIFY_TH: Record<string, string> = { verified: "ผ่าน", rejected: "ไม่ผ่าน", needs_review: "ตรวจเอง" };

/** "2026-10-28 16:48:05" in Thai time — what accountants expect to see in a sheet. */
export function bangkokTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(Date.parse(iso) + 7 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
}

export function paymentExportTable(rows: (PaymentRow & { merchant_name?: string })[], withMerchant: boolean) {
  const headers = [
    ...(withMerchant ? ["ร้านค้า", "รหัสร้าน"] : []),
    "วันที่สร้าง",
    "วันที่ชำระ",
    "รหัสรายการ",
    "เลขอ้างอิง",
    "รายละเอียด",
    "ช่องทาง",
    "สถานะ",
    "ยอดเงิน (บาท)",
    "เลขอ้างอิงธนาคาร",
    "ผลตรวจสลิป",
    "หมายเหตุ",
    "โหมด",
  ];
  const data: Cell[][] = rows.map((p) => [
    ...(withMerchant ? [p.merchant_name ?? "", p.merchant_id] : []),
    bangkokTime(p.created_at),
    bangkokTime(p.paid_at),
    p.id,
    p.reference,
    p.description,
    METHOD_TH[p.method] ?? p.method,
    STATUS_TH[p.status] ?? p.status,
    p.amount / 100,
    p.slip_trans_ref,
    p.verify_status ? (VERIFY_TH[p.verify_status] ?? p.verify_status) : "",
    p.failure_reason ?? p.verify_reason,
    p.livemode === 1 ? "จริง" : "ทดสอบ",
  ]);
  return { headers, data };
}

/**
 * CSV for Excel: UTF-8 BOM so Thai renders, CRLF rows, and formula-looking text neutralised
 * so a customer-supplied description cannot run as a spreadsheet formula.
 */
export function toCsv(headers: string[], rows: Cell[][]): Buffer {
  const cell = (v: Cell) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return String(v);
    let s = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers, ...rows].map((r) => r.map(cell).join(","));
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join("\r\n") + "\r\n", "utf8")]);
}

// ---------------------------------------------------------------------------
// Minimal XLSX writer (one sheet, inline strings, bold frozen header, number format for money).

function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(headers: string[], rows: Cell[][]): string {
  const widths = headers.map((h, i) =>
    Math.min(60, Math.max(h.length + 4, ...rows.slice(0, 500).map((r) => String(r[i] ?? "").length + 2))),
  );
  const cellXml = (v: Cell, ref: string, header: boolean) => {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number") return `<c r="${ref}" s="2"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ""}><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
  };
  const rowXml = (r: Cell[], idx: number, header: boolean) =>
    `<row r="${idx + 1}">${r.map((v, c) => cellXml(v, colName(c) + (idx + 1), header)).join("")}</row>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData>${rowXml(headers, 0, true)}${rows.map((r, i) => rowXml(r, i + 1, false)).join("")}</sheetData>` +
    (rows.length ? `<autoFilter ref="A1:${colName(headers.length - 1)}${rows.length + 1}"/>` : "") +
    "</worksheet>"
  );
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="11"/><name val="Tahoma"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

export function toXlsx(sheetName: string, headers: string[], rows: Cell[][]): Buffer {
  const name = xmlText(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1");
  return zip([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      "xl/workbook.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>` +
        (rows.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${colName(headers.length - 1)}$${rows.length + 1}</definedName></definedNames>` : "") +
        "</workbook>",
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ],
    ["xl/styles.xml", STYLES],
    ["xl/worksheets/sheet1.xml", sheetXml(headers, rows)],
  ]);
}

/** Writes a ZIP archive (deflate) — just enough for OOXML packages. */
function zip(files: [name: string, content: string][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const dosTime = 0; // 00:00:00
  const dosDate = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01; mtime is irrelevant here
  for (const [name, content] of files) {
    const raw = Buffer.from(content, "utf8");
    const data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
