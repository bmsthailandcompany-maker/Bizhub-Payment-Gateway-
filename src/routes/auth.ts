import type { FastifyReply, FastifyRequest } from "fastify";
import { safeEqual } from "../ids.ts";
import type { MerchantRow, MerchantService } from "../services/merchants.ts";
import type { Actor } from "../services/sessions.ts";

declare module "fastify" {
  interface FastifyRequest {
    merchant?: MerchantRow;
    livemode?: boolean;
    /** Set for cookie-session web requests. */
    actor?: Actor;
    sessionToken?: string;
    permissions?: readonly string[];
  }
}

function bearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim();
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid or missing API key" } });
}

export function merchantAuth(merchants: MerchantService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = bearer(req);
    const auth = key ? merchants.authenticate(key) : undefined;
    if (!auth) return unauthorized(reply);
    req.merchant = auth.merchant;
    req.livemode = auth.livemode;
  };
}

export function adminAuth(adminToken: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    if (!token || !safeEqual(token, adminToken)) return unauthorized(reply);
  };
}
