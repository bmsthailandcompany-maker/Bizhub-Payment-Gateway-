import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { PaymentError } from "../services/payments.ts";
import { type Cell, MAX_EXPORT_ROWS, toCsv, toXlsx } from "../services/export.ts";
import { SESSION_TTL_MS } from "../services/sessions.ts";

/** Shared plumbing for the two cookie-session web apps (merchant dashboard and admin console). */

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, name: string, path: string, token: string | null) {
  const secure = req.protocol === "https" ? "; Secure" : "";
  const maxAge = token ? SESSION_TTL_MS / 1000 : 0;
  reply.header(
    "Set-Cookie",
    `${name}=${encodeURIComponent(token ?? "")}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`,
  );
}

/** Writes need this header: SameSite=Strict already stops cross-site cookies, this is defence in depth. */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "bizhub-web";

export function csrfOk(req: FastifyRequest): boolean {
  return req.method === "GET" || req.headers[CSRF_HEADER] === CSRF_VALUE;
}

export function loginKey(req: FastifyRequest, who: string): string {
  return `${req.ip}|${who.trim().toLowerCase()}`;
}

export function pageHeaders(reply: FastifyReply) {
  return reply
    .type("text/html; charset=utf-8")
    .header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    )
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header("Cache-Control", "no-store");
}

/** The shell both apps load; all behaviour lives in the static scripts. */
export function appShell(title: string, script: string): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/assets/ui.css">
</head>
<body>
<div id="app"></div>
<script src="/assets/ui.js"></script>
<script src="/assets/${script}"></script>
</body>
</html>`;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

export const exportQuery = z.object({
  format: z.enum(["csv", "xlsx"]).default("xlsx"),
  status: z.enum(["pending", "awaiting_review", "succeeded", "failed", "expired", "cancelled"]).optional(),
  q: z.string().max(100).optional(),
  from: day.optional(),
  to: day.optional(),
});

/** Turns Thai calendar days (inclusive) into a created_at range. */
export function bangkokRange(from?: string, to?: string): { from?: string; to?: string } {
  const start = (d: string) => new Date(Date.parse(d + "T00:00:00+07:00")).toISOString();
  return {
    from: from ? start(from) : undefined,
    to: to ? new Date(Date.parse(to + "T00:00:00+07:00") + 86400_000).toISOString() : undefined,
  };
}

export function sendExport(
  reply: FastifyReply,
  format: "csv" | "xlsx",
  baseName: string,
  table: { headers: string[]; data: Cell[][] },
) {
  if (table.data.length > MAX_EXPORT_ROWS) {
    throw new PaymentError(413, "export_too_large", `ส่งออกได้ครั้งละไม่เกิน ${MAX_EXPORT_ROWS.toLocaleString()} รายการ กรุณาเลือกช่วงวันที่ให้แคบลง`);
  }
  const stamp = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const file = `${baseName}-${stamp}.${format}`;
  const body = format === "csv" ? toCsv(table.headers, table.data) : toXlsx("รายการชำระเงิน", table.headers, table.data);
  return reply
    .type(format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .header("Content-Disposition", `attachment; filename="${file}"`)
    .header("Cache-Control", "no-store")
    .send(body);
}
