import type { EconomicEvent, Impact } from "./types.js";
import { errMsg, fetchWithTimeout, sha256 } from "./util.js";

/**
 * Calendario económico gratuito.
 *
 * LIMITACIÓN IMPORTANTE: no existe una API de calendario realmente gratuita, oficial y
 * con "dato publicado". Se usa el JSON público semanal de Faireconomy (el mismo que
 * alimenta ForexFactory). Es NO oficial: puede cambiar, limitar peticiones o desaparecer.
 * Trae fecha/hora, impacto, previsión y dato anterior. El "dato publicado" solo se
 * muestra si la fuente lo incluye; si no, se indica "no disponible" (nunca se inventa).
 */
export const CALENDAR_URLS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
];

interface RawEvent {
  title?: unknown;
  country?: unknown;
  date?: unknown;
  impact?: unknown;
  forecast?: unknown;
  previous?: unknown;
  actual?: unknown;
}

const CATEGORY_RULES: Array<{ re: RegExp; category: string; alwaysHigh?: boolean }> = [
  { re: /\bcore pce|\bpce\b/i, category: "PCE", alwaysHigh: true },
  { re: /\bcore cpi|\bcpi\b/i, category: "CPI", alwaysHigh: true },
  { re: /\bppi\b/i, category: "PPI" },
  { re: /non-?farm|\bnfp\b/i, category: "NFP", alwaysHigh: true },
  { re: /unemployment rate/i, category: "Desempleo", alwaysHigh: true },
  { re: /unemployment claims|jobless claims/i, category: "Peticiones de desempleo" },
  { re: /jolts|job openings/i, category: "JOLTS" },
  { re: /fomc|federal funds rate|fed (chair|interest)|powell|interest rate decision/i, category: "FOMC / tipos", alwaysHigh: true },
  { re: /ism .*(pmi|manufacturing|services)|ism (manufacturing|services)/i, category: "ISM" },
  { re: /\bpmi\b/i, category: "PMI" },
  { re: /\bgdp\b/i, category: "PIB" },
  { re: /retail sales/i, category: "Ventas minoristas" },
];

export function categorize(title: string): { category: string | null; alwaysHigh: boolean } {
  for (const r of CATEGORY_RULES) {
    if (r.re.test(title)) return { category: r.category, alwaysHigh: !!r.alwaysHigh };
  }
  return { category: null, alwaysHigh: false };
}

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function parseCalendar(json: unknown): EconomicEvent[] {
  if (!Array.isArray(json)) return [];
  const events: EconomicEvent[] = [];

  for (const r of json as RawEvent[]) {
    const title = clean(r.title);
    const dateStr = clean(r.date);
    if (!title || !dateStr) continue;
    if (String(r.country).toUpperCase() !== "USD") continue;

    const when = new Date(dateStr);
    if (Number.isNaN(when.getTime())) continue;

    const srcImpact = String(r.impact ?? "").toLowerCase();
    const { category, alwaysHigh } = categorize(title);

    let impact: Impact | null = null;
    if (srcImpact === "high") impact = "ALTO";
    else if (srcImpact === "medium") impact = "MEDIO";
    else if (srcImpact === "low") impact = "BAJO";
    // Datos clave: siempre se tratan como alto impacto si la fuente los trae
    if (alwaysHigh && (srcImpact === "high" || srcImpact === "medium")) impact = "ALTO";

    // Nos quedamos con alto impacto y con medio impacto de categorías que seguimos
    const keep = impact === "ALTO" || (impact === "MEDIO" && category !== null);
    if (!keep || !impact) continue;

    events.push({
      id: sha256(`${title}|${when.toISOString()}`),
      title,
      category,
      event_time: when.toISOString(),
      country: "USD",
      impact,
      forecast: clean(r.forecast),
      previous: clean(r.previous),
      actual: clean(r.actual),
      alert_sent: false,
    });
  }
  return events.sort((a, b) => a.event_time.localeCompare(b.event_time));
}

export async function fetchCalendar(
  f: typeof fetch
): Promise<{ events: EconomicEvent[]; errors: string[] }> {
  const events = new Map<string, EconomicEvent>();
  const errors: string[] = [];

  for (const url of CALENDAR_URLS) {
    try {
      const res = await fetchWithTimeout(
        f,
        url,
        { headers: { "User-Agent": "NasdaqSP500NewsBot/1.0", Accept: "application/json" } },
        10_000
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const e of parseCalendar(await res.json())) events.set(e.id, e);
    } catch (e) {
      errors.push(`${url.split("/").pop()}: ${errMsg(e)}`);
    }
  }
  return { events: [...events.values()], errors };
}

/** Agrupa eventos simultáneos de la misma categoría (p. ej. CPI y CPI subyacente). */
export function groupSimultaneous(events: EconomicEvent[]): EconomicEvent[][] {
  const groups = new Map<string, EconomicEvent[]>();
  for (const e of events) {
    const key = `${e.event_time}|${e.category ?? e.title}`;
    const g = groups.get(key) ?? [];
    g.push(e);
    groups.set(key, g);
  }
  return [...groups.values()];
}
