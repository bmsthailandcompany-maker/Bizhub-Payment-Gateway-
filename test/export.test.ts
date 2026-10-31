import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { toCsv, toXlsx } from "../src/services/export.ts";

test("CSV neutralises formula-looking text and quotes properly", () => {
  const out = toCsv(["a", "b"], [["=HYPERLINK(\"x\")", 1.5], ['he said "hi", ok', null], ["-10", "+1"]]).toString("utf8");
  const lines = out.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[1], `"'=HYPERLINK(""x"")",1.5`);
  assert.equal(lines[2], `"he said ""hi"", ok",`);
  assert.equal(lines[3], "'-10,'+1");
});

test("XLSX opens in a real spreadsheet reader with Thai text, numbers and a frozen header", (t) => {
  let hasPython = true;
  try {
    execFileSync("python3", ["-I", "-c", "import openpyxl"], { stdio: "ignore" });
  } catch {
    hasPython = false;
  }
  if (!hasPython) return t.skip("python3 + openpyxl not available");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-"));
  const file = path.join(dir, "t.xlsx");
  fs.writeFileSync(file, toXlsx("รายการ", ["ร้าน", "ยอด (บาท)", "หมายเหตุ"], [["ร้าน <&> \"กาแฟ\"", 1234.5, "=SUM(A1)"], ["B", 0.1, null]]));
  const out = execFileSync("python3", [
    "-I",
    "-c",
    "import openpyxl,sys,json;ws=openpyxl.load_workbook(sys.argv[1]).active;" +
      "print(json.dumps({'title':ws.title,'freeze':ws.freeze_panes,'rows':[list(r) for r in ws.iter_rows(values_only=True)],'fmt':ws['B2'].number_format,'bold':ws['A1'].font.b,'type':ws['C2'].data_type}, ensure_ascii=False))",
    file,
  ]).toString();
  fs.rmSync(dir, { recursive: true, force: true });
  const r = JSON.parse(out);
  assert.equal(r.title, "รายการ");
  assert.equal(r.freeze, "A2");
  assert.deepEqual(r.rows, [["ร้าน", "ยอด (บาท)", "หมายเหตุ"], ['ร้าน <&> "กาแฟ"', 1234.5, "=SUM(A1)"], ["B", 0.1, null]]);
  assert.equal(r.fmt, "#,##0.00");
  assert.equal(r.bold, true);
  assert.equal(r.type, "s", "formula-looking text stays text, never a formula");
});
