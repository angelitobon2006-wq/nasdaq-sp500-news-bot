import type { Llm, LlmRequest, LlmResult } from "../lib/anthropic.js";
import { loadSettings } from "../lib/config.js";
import type { Db, UsageToday } from "../lib/db.js";
import type { Deps } from "../lib/deps.js";
import type { DiscordPoster, MessagePayload } from "../lib/discord.js";
import type {
  Analysis,
  EconomicEvent,
  FeedItem,
  Impact,
  JobRun,
  NewsRow,
  SummaryData,
} from "../lib/types.js";

/** Base de datos en memoria que imita las garantías de Supabase (claves únicas, reservas atómicas). */
export class MemoryDb implements Db {
  news: NewsRow[] = [];
  jobs: Array<JobRun & { stats: Record<string, unknown> | null }> = [];
  usage: Array<{ kind: string; input: number; output: number; at: string }> = [];
  summaries = new Map<string, { summary: SummaryData | null; msg: string | null; created_at: string }>();
  events = new Map<string, EconomicEvent>();
  kv = new Map<string, unknown>();
  publications: Array<{ kind: string; refId: string | null; messageId: string }> = [];
  private seq = 0;

  constructor(private clock: () => Date) {}

  private nowISO() {
    return this.clock().toISOString();
  }

  async tryStartJob(job: string, bucket: string) {
    if (this.jobs.some((j) => j.job === job && j.bucket === bucket)) return false;
    this.jobs.push({
      job, bucket, status: "running", started_at: this.nowISO(), finished_at: null, stats: null, error: null,
    });
    return true;
  }
  async finishJob(job: string, bucket: string, status: "ok" | "error", stats: Record<string, unknown>, error?: string) {
    const j = this.jobs.find((x) => x.job === job && x.bucket === bucket);
    if (j) Object.assign(j, { status, stats, error: error ?? null, finished_at: this.nowISO() });
  }
  async lastJobRuns() {
    return [...this.jobs].reverse();
  }

  async failStaleProcessing(olderThanISO: string) {
    let n = 0;
    for (const r of this.news) {
      if (r.status === "processing" && r.created_at < olderThanISO) {
        r.status = "failed";
        n++;
      }
    }
    return n;
  }
  async existingHashes(hashes: string[]) {
    const set = new Set(this.news.map((r) => r.url_hash));
    return new Set(hashes.filter((h) => set.has(h)));
  }
  async recentTitleKeys(sinceISO: string, limit: number) {
    return this.news.filter((r) => r.created_at >= sinceISO).slice(-limit).map((r) => r.title_key);
  }
  private add(i: FeedItem, status: "skipped" | "processing"): NewsRow | null {
    if (this.news.some((r) => r.url_hash === i.urlHash)) return null;
    const row: NewsRow = {
      id: `n${++this.seq}`, url_hash: i.urlHash, url: i.url, title: i.title, title_key: i.titleKey,
      summary: i.summary, source: i.source, published_at: i.publishedAt, relevance_score: i.score,
      status, impact: null, analysis: null, error: null, discord_message_id: null, created_at: this.nowISO(),
    };
    this.news.push(row);
    return row;
  }
  async insertSkipped(items: FeedItem[]) {
    for (const i of items) this.add(i, "skipped");
  }
  async claimNewItems(items: FeedItem[]) {
    return items.map((i) => this.add(i, "processing")).filter((r): r is NewsRow => r !== null);
  }
  private get(id: string) {
    const r = this.news.find((x) => x.id === id);
    if (!r) throw new Error("fila no encontrada " + id);
    return r;
  }
  async saveAnalysis(id: string, a: Analysis) {
    Object.assign(this.get(id), { status: "analyzed", impact: a.impacto, analysis: a });
  }
  async markSkipped(id: string, a: Analysis | null) {
    Object.assign(this.get(id), { status: "skipped", analysis: a, impact: a?.impacto ?? null });
  }
  async markArchived(id: string, a: Analysis) {
    Object.assign(this.get(id), { status: "archived", impact: a.impacto, analysis: a });
  }
  failMarkPublished = false;
  async markPublished(id: string, messageId: string) {
    if (this.failMarkPublished) throw new Error("fallo simulado al guardar");
    Object.assign(this.get(id), { status: "published", discord_message_id: messageId });
  }
  async markFailed(id: string, error: string) {
    Object.assign(this.get(id), { status: "failed", error });
  }
  async unpostedAnalyzed(sinceISO: string, limit: number) {
    return this.news.filter((r) => r.status === "analyzed" && r.created_at >= sinceISO).slice(0, limit);
  }
  async expireUnposted(beforeISO: string) {
    for (const r of this.news) if (r.status === "analyzed" && r.created_at < beforeISO) r.status = "archived";
  }
  async analysesSince(sinceISO: string) {
    return this.news.filter(
      (r) => r.analysis && ["analyzed", "published", "archived"].includes(r.status) && r.created_at >= sinceISO
    );
  }
  async statusCounts(sinceISO: string) {
    const out: Record<string, number> = {};
    for (const r of this.news) if (r.created_at >= sinceISO) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }

  async usageToday(sinceISO: string): Promise<UsageToday> {
    const u: UsageToday = { tokens: 0, newsAnalyses: 0, manualAnalyses: 0, summaries: 0 };
    for (const r of this.usage) {
      if (r.at < sinceISO) continue;
      u.tokens += r.input + r.output;
      if (r.kind === "news") u.newsAnalyses++;
      else if (r.kind === "manual") u.manualAnalyses++;
      else u.summaries++;
    }
    return u;
  }
  async addUsage(kind: "news" | "summary" | "manual", _m: string, input: number, output: number) {
    this.usage.push({ kind, input, output, at: this.nowISO() });
  }

  async claimSummary(bucket: string) {
    if (this.summaries.has(bucket)) return false;
    this.summaries.set(bucket, { summary: null, msg: null, created_at: this.nowISO() });
    return true;
  }
  async saveSummary(bucket: string, summary: SummaryData, messageId: string | null) {
    const s = this.summaries.get(bucket);
    if (s) Object.assign(s, { summary, msg: messageId });
  }
  async releaseSummary(bucket: string) {
    if (this.summaries.get(bucket)?.summary === null) this.summaries.delete(bucket);
  }
  async latestSummary() {
    const done = [...this.summaries.entries()].filter(([, v]) => v.summary).sort((a, b) => b[0].localeCompare(a[0]));
    if (!done.length) return null;
    return { bucket: done[0][0], summary: done[0][1].summary as SummaryData, created_at: done[0][1].created_at };
  }

  async upsertEvents(events: EconomicEvent[]) {
    for (const e of events) {
      const old = this.events.get(e.id);
      this.events.set(e.id, { ...e, alert_sent: old?.alert_sent ?? false });
    }
  }
  async upcomingEvents(fromISO: string, toISO: string, impacts: Impact[]) {
    return [...this.events.values()]
      .filter((e) => e.event_time >= fromISO && e.event_time <= toISO && impacts.includes(e.impact))
      .sort((a, b) => a.event_time.localeCompare(b.event_time));
  }
  async claimDueAlerts(nowISO: string, untilISO: string) {
    const due = [...this.events.values()].filter(
      (e) => !e.alert_sent && e.impact === "ALTO" && e.event_time > nowISO && e.event_time <= untilISO
    );
    for (const e of due) e.alert_sent = true;
    return due.map((e) => ({ ...e }));
  }
  async releaseAlert(id: string) {
    const e = this.events.get(id);
    if (e) e.alert_sent = false;
  }

  async kvGet<T>(key: string) {
    return (this.kv.get(key) as T | undefined) ?? null;
  }
  async kvSet(key: string, value: unknown) {
    this.kv.set(key, value);
  }
  async recordPublication(kind: string, refId: string | null, _c: string, messageId: string) {
    this.publications.push({ kind, refId, messageId });
  }
}

export class FakeLlm implements Llm {
  calls: LlmRequest[] = [];
  constructor(public respond: (req: LlmRequest, n: number) => string = () => analysisJson()) {}
  async complete(req: LlmRequest): Promise<LlmResult> {
    this.calls.push(req);
    return { text: this.respond(req, this.calls.length), inputTokens: 1200, outputTokens: 800, model: "fake" };
  }
}

export class FakeDiscord implements DiscordPoster {
  posts: Array<{ channelId: string; payload: MessagePayload }> = [];
  failNext = 0;
  async postMessage(channelId: string, payload: MessagePayload) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Discord caído (simulado)");
    }
    this.posts.push({ channelId, payload });
    return `msg${this.posts.length}`;
  }
}

export function analysisJson(over: Record<string, unknown> = {}): string {
  const scenario = {
    que_favorece: "Un dato más suave de lo esperado reduciría la presión sobre los tipos.",
    factores: ["Inflación a la baja", "Rendimientos del bono en descenso"],
    confirmacion: ["Cierre por encima del máximo previo", "Caída del rendimiento a 10 años"],
  };
  return JSON.stringify({
    relevante: true,
    impacto: "ALTO",
    motivo_impacto: "Afecta a las expectativas de tipos de la Fed.",
    mercados: ["NASDAQ", "SP500"],
    titular_es: "La Fed mantiene los tipos",
    que_ha_ocurrido: "La Reserva Federal dejó los tipos sin cambios.",
    contexto: "Inflación aún por encima del objetivo.",
    repercusion_nasdaq: "El Nasdaq es más sensible a los tipos por su peso en tecnología.",
    repercusion_sp500: "Efecto algo menor en el S&P 500.",
    descontado: "El mercado ya esperaba el mantenimiento.",
    escenario_alcista: scenario,
    escenario_bajista: { ...scenario, que_favorece: "Un tono duro del presidente de la Fed." },
    sesgo_nasdaq: "ALCISTA",
    sesgo_sp500: "NEUTRAL",
    conclusion: "MIXTO",
    confianza: "MEDIA",
    ...over,
  });
}

export const rssItem = (title: string, link: string, minutesOld = 5, now = new Date()) =>
  `<item><title>${title}</title><link>${link}</link><description>Texto de ${title}</description><pubDate>${new Date(
    now.getTime() - minutesOld * 60_000
  ).toUTCString()}</pubDate></item>`;

export const rss = (...items: string[]) => `<?xml version="1.0"?><rss><channel>${items.join("")}</channel></rss>`;

/** fetch simulado: todas las fuentes RSS devuelven el mismo XML; el calendario devuelve su JSON. */
export function fakeFetch(xml: string, calendar: unknown = []): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes("faireconomy")) {
      return new Response(JSON.stringify(calendar), { status: 200 });
    }
    return new Response(xml, { status: 200 });
  }) as typeof fetch;
}

export interface Harness {
  deps: Deps;
  db: MemoryDb;
  llm: FakeLlm;
  discord: FakeDiscord;
  clock: { now: Date };
}

export function makeHarness(opts: {
  start?: string;
  xml?: string;
  calendar?: unknown;
  env?: Record<string, string>;
  llm?: FakeLlm;
} = {}): Harness {
  const clock = { now: new Date(opts.start ?? "2026-11-04T14:03:00Z") };
  const db = new MemoryDb(() => clock.now);
  const llm = opts.llm ?? new FakeLlm();
  const discord = new FakeDiscord();
  const deps: Deps = {
    db,
    llm,
    discord,
    settings: loadSettings({ MAX_ANALYSES_PER_RUN: "3", ...(opts.env ?? {}) }),
    channelId: "chan1",
    fetchImpl: fakeFetch(opts.xml ?? rss(), opts.calendar ?? []),
    now: () => clock.now,
  };
  return { deps, db, llm, discord, clock };
}
