import { createHash } from "node:crypto";

export const TZ = "Europe/Madrid";

export function sha256(text: string, len = 32): string {
  return createHash("sha256").update(text).digest("hex").slice(0, len);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function truncate(text: string, max: number): string {
  const t = String(text ?? "");
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff
        ? String.fromCodePoint(code)
        : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Quita CDATA, etiquetas HTML y entidades. */
export function stripHtml(s: string): string {
  const sinCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const decodificado = decodeEntities(sinCdata);
  return decodificado.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Normaliza una URL para detectar la misma noticia con distintos parámetros. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|cmpid|ocid|taid|ref$|\.tsrc)/i.test(k)) {
        u.searchParams.delete(k);
      }
    }
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

export async function fetchWithTimeout(
  f: typeof fetch,
  url: string,
  init: RequestInit = {},
  ms = 10_000
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await f(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Extrae el primer objeto JSON de un texto (por si el modelo añade texto o ```). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("La respuesta no contiene JSON");
  return JSON.parse(text.slice(start, end + 1));
}

// ---------------------------------------------------------------
// Fechas y zona horaria (Europe/Madrid, con cambio de horario
// verano/invierno gestionado automáticamente por Intl)
// ---------------------------------------------------------------

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function partsIn(date: Date, timeZone: string = TZ): Parts {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(date)) {
    if (p.type !== "literal") o[p.type] = parseInt(p.value, 10);
  }
  return {
    year: o.year,
    month: o.month,
    day: o.day,
    hour: o.hour,
    minute: o.minute,
    second: o.second,
  };
}

/** Minutos de diferencia entre la zona horaria y UTC en ese instante. */
export function tzOffsetMinutes(date: Date, timeZone: string = TZ): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const real = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - real) / 60_000);
}

export function madridHour(date: Date): number {
  return partsIn(date, TZ).hour;
}

/** Instante UTC (ISO) en que empezó el día actual en Madrid. */
export function startOfMadridDayISO(now: Date): string {
  const p = partsIn(now, TZ);
  const guess = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  const off1 = tzOffsetMinutes(new Date(guess), TZ);
  let instant = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(new Date(instant), TZ);
  if (off2 !== off1) instant = guess - off2 * 60_000;
  return new Date(instant).toISOString();
}

export function floorMinutes(date: Date, minutes: number): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

export function floorHour(date: Date): Date {
  return floorMinutes(date, 60);
}

export function formatMadrid(
  d: Date | string,
  style: "full" | "time" | "date" = "full"
): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions =
    style === "time"
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
      : style === "date"
        ? { weekday: "short", day: "2-digit", month: "short" }
        : {
            weekday: "short",
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          };
  return new Intl.DateTimeFormat("es-ES", { timeZone: TZ, ...opts }).format(date);
}

export function minutesAgoISO(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}
