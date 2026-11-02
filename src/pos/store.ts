import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { calculateOrder } from "./finance.ts";

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
}
export class PosStore {
  constructor(private db: Db) {}
  product(merchant: string, name: string, price: number, cost=0) {
    if (!merchant || !name.trim() || !Number.isSafeInteger(price) || price<0 || !Number.isSafeInteger(cost) || cost<0) throw Error("invalid product");
    const id=randomUUID();
    this.db.prepare("INSERT INTO pos_products(id,merchant_id,name,price,cost) VALUES(?,?,?,?,?)").run(id,merchant,name,price,cost);
    return id;
  }
  products(merchant:string) { return this.db.prepare("SELECT id,name,price,cost FROM pos_products WHERE merchant_id=? AND active=1").all(merchant); }
  qr(merchant:string,promptpay:string) {
    if(!merchant || !/^[0-9]{10,15}$/.test(promptpay)) throw Error("invalid PromptPay");
    this.db.prepare("INSERT INTO pos_qr(merchant_id,promptpay_id,owner_verified) VALUES(?,?,0) ON CONFLICT(merchant_id) DO UPDATE SET promptpay_id=excluded.promptpay_id,owner_verified=0").run(merchant,promptpay);
  }
  order(merchant:string,items:{productId:string;quantity:number}[]) {
    if(!merchant || !items.length) throw Error("empty order");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lines=items.map(i=>{
        const p=this.db.prepare("SELECT id,name,price,cost FROM pos_products WHERE id=? AND merchant_id=? AND active=1").get(i.productId,merchant) as {id:string;name:string;price:number;cost:number}|undefined;
        if(!p) throw Error("product not found");
        return {productId:p.id,name:p.name,quantity:i.quantity,unitPriceSatang:p.price,unitCostSatang:p.cost};
      });
      const total=calculateOrder(lines);
      const id=randomUUID();
      this.db.prepare("INSERT INTO pos_orders(id,merchant_id,status,total,cost,created_at) VALUES(?,?,'open',?,?,?)").run(id,merchant,total.totalSatang,total.costSatang,new Date().toISOString());
      for(const l of lines) this.db.prepare("INSERT INTO pos_lines(order_id,merchant_id,product_id,name,quantity,unit_price) VALUES(?,?,?,?,?,?)").run(id,merchant,l.productId,l.name,l.quantity,l.unitPriceSatang);
      this.db.exec("COMMIT");
      return id;
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
  }
  cash(merchant:string,id:string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result=this.db.prepare("UPDATE pos_orders SET status='paid' WHERE id=? AND merchant_id=? AND status='open'").run(id,merchant);
      if(result.changes!==1) throw Error("order unavailable");
      const o=this.db.prepare("SELECT total FROM pos_orders WHERE id=? AND merchant_id=?").get(id,merchant) as {total:number};
      this.db.prepare("INSERT INTO pos_ledger(id,merchant_id,order_id,kind,amount,category,created_at) VALUES(?,?,?,'income',?,'sales',?)").run(randomUUID(),merchant,id,o.total,new Date().toISOString());
      this.db.exec("COMMIT");
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
  }
  expense(merchant:string,category:string,amount:number) {
    if(!merchant || !category.trim() || !Number.isSafeInteger(amount) || amount<0) throw Error("invalid expense");
    this.db.prepare("INSERT INTO pos_ledger(id,merchant_id,kind,amount,category,created_at) VALUES(?,?,'expense',?,?,?)").run(randomUUID(),merchant,amount,category,new Date().toISOString());
  }
  summary(merchant:string) {
    const r=this.db.prepare("SELECT kind,SUM(amount) AS total FROM pos_ledger WHERE merchant_id=? GROUP BY kind").all(merchant) as {kind:string;total:number}[];
    const income=r.find(x=>x.kind==="income")?.total??0, expenses=r.find(x=>x.kind==="expense")?.total??0;
    return {incomeSatang:income,expenseSatang:expenses,netSatang:income-expenses};
  }
}
