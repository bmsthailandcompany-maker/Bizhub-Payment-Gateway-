import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { calculateOrder } from "./finance.ts";
import { PaymentError } from "../services/payments.ts";

const bad = (msg: string) => new PaymentError(400, "invalid_request", msg);

export function migratePos(db: Db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS pos_products (id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), cost INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS pos_products_merchant ON pos_products(merchant_id);
CREATE TABLE IF NOT EXISTS pos_qr (merchant_id TEXT PRIMARY KEY, promptpay_id TEXT NOT NULL, owner_verified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pos_orders (id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL, cost INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pos_lines (order_id TEXT NOT NULL, merchant_id TEXT NOT NULL, product_id TEXT NOT NULL, name TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pos_ledger (id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, order_id TEXT, kind TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0), category TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(merchant_id,order_id,kind));
CREATE INDEX IF NOT EXISTS pos_ledger_merchant ON pos_ledger(merchant_id);
`);
  // Test-key and live-key data are kept apart, like payments. Rows from before this column are live.
  const has = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "livemode");
  for (const t of ["pos_products", "pos_orders", "pos_lines", "pos_ledger"]) {
    if (!has(t)) db.exec(`ALTER TABLE ${t} ADD COLUMN livemode INTEGER NOT NULL DEFAULT 1`);
  }
  if (!has("pos_qr")) {
    db.exec(`
CREATE TABLE pos_qr_v2 (merchant_id TEXT NOT NULL, livemode INTEGER NOT NULL DEFAULT 1, promptpay_id TEXT NOT NULL, owner_verified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (merchant_id, livemode));
INSERT INTO pos_qr_v2 (merchant_id, livemode, promptpay_id, owner_verified) SELECT merchant_id, 1, promptpay_id, owner_verified FROM pos_qr;
DROP TABLE pos_qr;
ALTER TABLE pos_qr_v2 RENAME TO pos_qr;`);
  }
}
export class PosStore {
  constructor(private db: Db) {}
  product(merchant: string, name: string, price: number, cost=0, live=true) {
    if (!merchant || !name.trim() || !Number.isSafeInteger(price) || price<0 || !Number.isSafeInteger(cost) || cost<0) throw bad("invalid product");
    const id=randomUUID();
    this.db.prepare("INSERT INTO pos_products(id,merchant_id,name,price,cost,livemode) VALUES(?,?,?,?,?,?)").run(id,merchant,name,price,cost,live?1:0);
    return id;
  }
  products(merchant:string, live=true) { return this.db.prepare("SELECT id,name,price,cost FROM pos_products WHERE merchant_id=? AND livemode=? AND active=1").all(merchant,live?1:0); }
  qr(merchant:string,promptpay:string,live=true) {
    if(!merchant || !/^[0-9]{10,15}$/.test(promptpay)) throw bad("invalid PromptPay");
    this.db.prepare("INSERT INTO pos_qr(merchant_id,livemode,promptpay_id,owner_verified) VALUES(?,?,?,0) ON CONFLICT(merchant_id,livemode) DO UPDATE SET promptpay_id=excluded.promptpay_id,owner_verified=0").run(merchant,live?1:0,promptpay);
  }
  order(merchant:string,items:{productId:string;quantity:number}[],live=true) {
    if(!merchant || !items.length) throw bad("empty order");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lines=items.map(i=>{
        const p=this.db.prepare("SELECT id,name,price,cost FROM pos_products WHERE id=? AND merchant_id=? AND livemode=? AND active=1").get(i.productId,merchant,live?1:0) as {id:string;name:string;price:number;cost:number}|undefined;
        if(!p) throw new PaymentError(404,"product_not_found","ไม่พบสินค้า");
        return {productId:p.id,name:p.name,quantity:i.quantity,unitPriceSatang:p.price,unitCostSatang:p.cost};
      });
      const total=calculateOrder(lines);
      const id=randomUUID();
      this.db.prepare("INSERT INTO pos_orders(id,merchant_id,status,total,cost,created_at,livemode) VALUES(?,?,'open',?,?,?,?)").run(id,merchant,total.totalSatang,total.costSatang,new Date().toISOString(),live?1:0);
      for(const l of lines) this.db.prepare("INSERT INTO pos_lines(order_id,merchant_id,product_id,name,quantity,unit_price,livemode) VALUES(?,?,?,?,?,?,?)").run(id,merchant,l.productId,l.name,l.quantity,l.unitPriceSatang,live?1:0);
      this.db.exec("COMMIT");
      return id;
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
  }
  cash(merchant:string,id:string,live=true) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result=this.db.prepare("UPDATE pos_orders SET status='paid' WHERE id=? AND merchant_id=? AND livemode=? AND status='open'").run(id,merchant,live?1:0);
      if(result.changes!==1) throw new PaymentError(409,"order_unavailable","ไม่พบออเดอร์ที่รอชำระ หรือชำระไปแล้ว");
      const o=this.db.prepare("SELECT total FROM pos_orders WHERE id=? AND merchant_id=?").get(id,merchant) as {total:number};
      this.db.prepare("INSERT INTO pos_ledger(id,merchant_id,order_id,kind,amount,category,created_at,livemode) VALUES(?,?,?,'income',?,'sales',?,?)").run(randomUUID(),merchant,id,o.total,new Date().toISOString(),live?1:0);
      this.db.exec("COMMIT");
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
  }
  expense(merchant:string,category:string,amount:number,live=true) {
    if(!merchant || !category.trim() || !Number.isSafeInteger(amount) || amount<0) throw bad("invalid expense");
    this.db.prepare("INSERT INTO pos_ledger(id,merchant_id,kind,amount,category,created_at,livemode) VALUES(?,?,'expense',?,?,?,?)").run(randomUUID(),merchant,amount,category,new Date().toISOString(),live?1:0);
  }
  summary(merchant:string,live=true) {
    const r=this.db.prepare("SELECT kind,SUM(amount) AS total FROM pos_ledger WHERE merchant_id=? AND livemode=? GROUP BY kind").all(merchant,live?1:0) as {kind:string;total:number}[];
    const income=r.find(x=>x.kind==="income")?.total??0, expenses=r.find(x=>x.kind==="expense")?.total??0;
    return {incomeSatang:income,expenseSatang:expenses,netSatang:income-expenses};
  }
}
