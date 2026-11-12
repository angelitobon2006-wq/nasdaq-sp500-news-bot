import { timingSafeEqual } from "node:crypto";
import { env } from "./config.js";
import { sha256 } from "./util.js";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Comprueba "Authorization: Bearer <CRON_SECRET>" sin filtrar información por tiempos. */
export function isAuthorizedCron(request: Request): boolean {
  const secret = env("CRON_SECRET");
  if (!secret || secret.length < 16) return false; // sin secreto fuerte, nada se ejecuta
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(sha256(given, 64));
  const b = Buffer.from(sha256(secret, 64));
  return a.length === b.length && timingSafeEqual(a, b);
}
