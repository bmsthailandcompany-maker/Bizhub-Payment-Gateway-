import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

/** Serves the dashboards' static scripts and styles (an explicit allowlist, loaded once at startup). */
export async function assetRoutes(app: FastifyInstance) {
  const files = new Map<string, { type: string; body: Buffer }>();
  for (const name of fs.readdirSync(DIR)) {
    const type = TYPES[path.extname(name)];
    if (type) files.set(name, { type, body: fs.readFileSync(path.join(DIR, name)) });
  }
  app.get<{ Params: { name: string } }>("/assets/:name", async (req, reply) => {
    const f = files.get(req.params.name);
    if (!f) return reply.code(404).send({ error: { code: "not_found", message: "Not found" } });
    return reply
      .type(f.type)
      .header("Cache-Control", "no-cache")
      .header("X-Content-Type-Options", "nosniff")
      .send(f.body);
  });
}
