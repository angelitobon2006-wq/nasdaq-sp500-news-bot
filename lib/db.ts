import type {
  Analysis,
  EconomicEvent,
  FeedItem,
  Impact,
  JobRun,
  NewsRow,
  SummaryData,
} from "./types.js";
import { chunk, fetchWithTimeout } from "./util.js";

export interface UsageToday {
  tokens: number;
  newsAnalyses: number;
  manualAnalyses: number;
  summaries: number;
}

/**
 * Todo el acceso a datos pasa por esta interfaz. Así el resto del código
 * es independiente de Supabase y se puede probar con una base simulada.
 */
export interface Db {
  // Bloqueo / idempotencia de ejecuciones
  tryStartJob(job: string, bucket: string): Promise<boolean>;
  finishJob(
    job: string,
    bucket: string,
    status: "ok" | "error",
    stats: Record<string, unknown>,
    error?: string
  ): Promise<void>;
  lastJobRuns(): Promise<JobRun[]>;

  // Noticias
  failStaleProcessing(olderThanISO: string): Promise<number>;
  existingHashes(hashes: string[]): Promise<Set<string>>;
  recentTitleKeys(sinceISO: string, limit: number): Promise<string[]>;
  insertSkipped(items: FeedItem[]): Promise<void>;
  /** Inserta como "processing" y devuelve SOLO las filas que este proceso consiguió reservar. */
  claimNewItems(items: FeedItem[]): Promise<NewsRow[]>;
  saveAnalysis(id: string, analysis: Analysis): Promise<void>;
  markSkipped(id: string, analysis: Analysis | null): Promise<void>;
  markArchived(id: string, analysis: Analysis): Promise<void>;
  markPublished(id: string, messageId: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  unpostedAnalyzed(sinceISO: string, limit: number): Promise<NewsRow[]>;
  expireUnposted(beforeISO: string): Promise<void>;
  analysesSince(sinceISO: string): Promise<NewsRow[]>;
  statusCounts(sinceISO: string): Promise<Record<string, number>>;

  // Consumo de Claude
  usageToday(sinceISO: string): Promise<UsageToday>;
  addUsage(
    kind: "news" | "summary" | "manual",
    model: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<void>;

  // Resúmenes horarios
  claimSummary(bucketISO: string): Promise<boolean>;
  saveSummary(bucketISO: string, summary: SummaryData, messageId: string | null): Promise<void>;
  releaseSummary(bucketISO: string): Promise<void>;
  latestSummary(): Promise<{ bucket: string; summary: SummaryData; created_at: string } | null>;

  // Calendario
  upsertEvents(events: EconomicEvent[]): Promise<void>;
  upcomingEvents(fromISO: string, toISO: string, impacts: Impact[]): Promise<EconomicEvent[]>;
  /** Marca como avisados (de forma atómica) y devuelve los eventos que tocan alertar. */
  claimDueAlerts(nowISO: string, untilISO: string): Promise<EconomicEvent[]>;
  releaseAlert(id: string): Promise<void>;

  // Varios
  kvGet<T>(key: string): Promise<T | null>;
  kvSet(key: string, value: unknown): Promise<void>;
  recordPublication(
    kind: string,
    refId: string | null,
    channelId: string,
    messageId: string
  ): Promise<void>;
}

// =================================================================
//  Implementación con Supabase (API REST de PostgREST, sin librerías)
// =================================================================

const enc = encodeURIComponent;

export class SupabaseDb implements Db {
  private base: string;

  constructor(
    url: string,
    private serviceKey: string,
    private f: typeof fetch = fetch
  ) {
    this.base = `${url.replace(/\/+$/, "")}/rest/v1`;
  }

  private async rest<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    table: string,
    query = "",
    body?: unknown,
    prefer?: string
  ): Promise<T> {
    const res = await fetchWithTimeout(
      this.f,
      `${this.base}/${table}${query ? `?${query}` : ""}`,
      {
        method,
        headers: {
          apikey: this.serviceKey,
          // Las claves nuevas (sb_secret_...) no son JWT: solo van en 'apikey'
          ...(this.serviceKey.startsWith("sb_") ? {} : { Authorization: `Bearer ${this.serviceKey}` }),
          "Content-Type": "application/json",
          ...(prefer ? { Prefer: prefer } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      12_000
    );
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`Supabase ${res.status} en ${table}: ${text}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  // ---- Ejecuciones ----
  async tryStartJob(job: string, bucket: string): Promise<boolean> {
    const rows = await this.rest<unknown[]>(
      "POST",
      "job_runs",
      "on_conflict=job,bucket",
      [{ job, bucket, status: "running" }],
      "resolution=ignore-duplicates,return=representation"
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  async finishJob(
    job: string,
    bucket: string,
    status: "ok" | "error",
    stats: Record<string, unknown>,
    error?: string
  ): Promise<void> {
    await this.rest(
      "PATCH",
      "job_runs",
      `job=eq.${enc(job)}&bucket=eq.${enc(bucket)}`,
      { status, stats, error: error ?? null, finished_at: new Date().toISOString() },
      "return=minimal"
    );
  }

  async lastJobRuns(): Promise<JobRun[]> {
    return (
      (await this.rest<JobRun[]>(
        "GET",
        "job_runs",
        "select=job,bucket,status,started_at,finished_at,stats,error&order=started_at.desc&limit=40"
      )) ?? []
    );
  }

  // ---- Noticias ----
  async failStaleProcessing(olderThanISO: string): Promise<number> {
    const rows = await this.rest<unknown[]>(
      "PATCH",
      "news_items",
      `status=eq.processing&created_at=lt.${enc(olderThanISO)}`,
      { status: "failed", error: "Tiempo agotado procesando la noticia" },
      "return=representation"
    );
    return rows?.length ?? 0;
  }

  async existingHashes(hashes: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const part of chunk(hashes, 80)) {
      const rows = await this.rest<Array<{ url_hash: string }>>(
        "GET",
        "news_items",
        `select=url_hash&url_hash=in.(${part.join(",")})`
      );
      for (const r of rows ?? []) found.add(r.url_hash);
    }
    return found;
  }

  async recentTitleKeys(sinceISO: string, limit: number): Promise<string[]> {
    const rows = await this.rest<Array<{ title_key: string }>>(
      "GET",
      "news_items",
      `select=title_key&created_at=gte.${enc(sinceISO)}&order=created_at.desc&limit=${limit}`
    );
    return (rows ?? []).map((r) => r.title_key).filter(Boolean);
  }

  private toRow(i: FeedItem, status: "skipped" | "processing"): Record<string, unknown> {
    return {
      url_hash: i.urlHash,
      url: i.url,
      title: i.title,
      title_key: i.titleKey,
      summary: i.summary,
      source: i.source,
      published_at: i.publishedAt,
      relevance_score: i.score,
      status,
    };
  }

  async insertSkipped(items: FeedItem[]): Promise<void> {
    for (const part of chunk(items, 100)) {
      await this.rest(
        "POST",
        "news_items",
        "on_conflict=url_hash",
        part.map((i) => this.toRow(i, "skipped")),
        "resolution=ignore-duplicates,return=minimal"
      );
    }
  }

  async claimNewItems(items: FeedItem[]): Promise<NewsRow[]> {
    if (items.length === 0) return [];
    const rows = await this.rest<NewsRow[]>(
      "POST",
      "news_items",
      "on_conflict=url_hash",
      items.map((i) => this.toRow(i, "processing")),
      "resolution=ignore-duplicates,return=representation"
    );
    return rows ?? [];
  }

  private async patchNews(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.rest("PATCH", "news_items", `id=eq.${enc(id)}`, patch, "return=minimal");
  }

  saveAnalysis(id: string, analysis: Analysis): Promise<void> {
    return this.patchNews(id, { status: "analyzed", impact: analysis.impacto, analysis });
  }
  markSkipped(id: string, analysis: Analysis | null): Promise<void> {
    return this.patchNews(id, {
      status: "skipped",
      analysis,
      impact: analysis?.impacto ?? null,
    });
  }
  markArchived(id: string, analysis: Analysis): Promise<void> {
    return this.patchNews(id, { status: "archived", impact: analysis.impacto, analysis });
  }
  markPublished(id: string, messageId: string): Promise<void> {
    return this.patchNews(id, { status: "published", discord_message_id: messageId });
  }
  markFailed(id: string, error: string): Promise<void> {
    return this.patchNews(id, { status: "failed", error: error.slice(0, 500) });
  }

  async unpostedAnalyzed(sinceISO: string, limit: number): Promise<NewsRow[]> {
    return (
      (await this.rest<NewsRow[]>(
        "GET",
        "news_items",
        `select=*&status=eq.analyzed&created_at=gte.${enc(sinceISO)}&order=created_at.asc&limit=${limit}`
      )) ?? []
    );
  }

  async expireUnposted(beforeISO: string): Promise<void> {
    await this.rest(
      "PATCH",
      "news_items",
      `status=eq.analyzed&created_at=lt.${enc(beforeISO)}`,
      { status: "archived" },
      "return=minimal"
    );
  }

  async analysesSince(sinceISO: string): Promise<NewsRow[]> {
    return (
      (await this.rest<NewsRow[]>(
        "GET",
        "news_items",
        `select=*&analysis=not.is.null&status=in.(analyzed,published,archived)&created_at=gte.${enc(sinceISO)}&order=created_at.desc&limit=200`
      )) ?? []
    );
  }

  async statusCounts(sinceISO: string): Promise<Record<string, number>> {
    const rows = await this.rest<Array<{ status: string }>>(
      "GET",
      "news_items",
      `select=status&created_at=gte.${enc(sinceISO)}&limit=5000`
    );
    const out: Record<string, number> = {};
    for (const r of rows ?? []) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }

  // ---- Consumo ----
  async usageToday(sinceISO: string): Promise<UsageToday> {
    const rows = await this.rest<
      Array<{ kind: string; input_tokens: number; output_tokens: number }>
    >(
      "GET",
      "claude_usage",
      `select=kind,input_tokens,output_tokens&created_at=gte.${enc(sinceISO)}&limit=5000`
    );
    const u: UsageToday = { tokens: 0, newsAnalyses: 0, manualAnalyses: 0, summaries: 0 };
    for (const r of rows ?? []) {
      u.tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
      if (r.kind === "news") u.newsAnalyses++;
      else if (r.kind === "manual") u.manualAnalyses++;
      else if (r.kind === "summary") u.summaries++;
    }
    return u;
  }

  async addUsage(
    kind: "news" | "summary" | "manual",
    model: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<void> {
    await this.rest(
      "POST",
      "claude_usage",
      "",
      [{ kind, model, input_tokens: inputTokens, output_tokens: outputTokens }],
      "return=minimal"
    );
  }

  // ---- Resúmenes ----
  async claimSummary(bucketISO: string): Promise<boolean> {
    const rows = await this.rest<unknown[]>(
      "POST",
      "hourly_summaries",
      "on_conflict=bucket",
      [{ bucket: bucketISO }],
      "resolution=ignore-duplicates,return=representation"
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  async saveSummary(
    bucketISO: string,
    summary: SummaryData,
    messageId: string | null
  ): Promise<void> {
    await this.rest(
      "PATCH",
      "hourly_summaries",
      `bucket=eq.${enc(bucketISO)}`,
      { summary, discord_message_id: messageId },
      "return=minimal"
    );
  }

  async releaseSummary(bucketISO: string): Promise<void> {
    await this.rest(
      "DELETE",
      "hourly_summaries",
      `bucket=eq.${enc(bucketISO)}&summary=is.null`,
      undefined,
      "return=minimal"
    );
  }

  async latestSummary() {
    const rows = await this.rest<
      Array<{ bucket: string; summary: SummaryData; created_at: string }>
    >(
      "GET",
      "hourly_summaries",
      "select=bucket,summary,created_at&summary=not.is.null&order=bucket.desc&limit=1"
    );
    return rows?.[0] ?? null;
  }

  // ---- Calendario ----
  async upsertEvents(events: EconomicEvent[]): Promise<void> {
    for (const part of chunk(events, 100)) {
      // Sin alert_sent en el cuerpo: así un evento ya avisado no se vuelve a avisar.
      await this.rest(
        "POST",
        "economic_events",
        "on_conflict=id",
        part.map((e) => ({
          id: e.id,
          title: e.title,
          category: e.category,
          event_time: e.event_time,
          country: e.country,
          impact: e.impact,
          forecast: e.forecast,
          previous: e.previous,
          actual: e.actual,
        })),
        "resolution=merge-duplicates,return=minimal"
      );
    }
  }

  async upcomingEvents(fromISO: string, toISO: string, impacts: Impact[]): Promise<EconomicEvent[]> {
    return (
      (await this.rest<EconomicEvent[]>(
        "GET",
        "economic_events",
        `select=*&event_time=gte.${enc(fromISO)}&event_time=lte.${enc(toISO)}&impact=in.(${impacts.join(",")})&order=event_time.asc&limit=60`
      )) ?? []
    );
  }

  async claimDueAlerts(nowISO: string, untilISO: string): Promise<EconomicEvent[]> {
    return (
      (await this.rest<EconomicEvent[]>(
        "PATCH",
        "economic_events",
        `alert_sent=eq.false&impact=eq.ALTO&event_time=gt.${enc(nowISO)}&event_time=lte.${enc(untilISO)}`,
        { alert_sent: true, alerted_at: nowISO },
        "return=representation"
      )) ?? []
    );
  }

  async releaseAlert(id: string): Promise<void> {
    await this.rest(
      "PATCH",
      "economic_events",
      `id=eq.${enc(id)}`,
      { alert_sent: false, alerted_at: null },
      "return=minimal"
    );
  }

  // ---- Varios ----
  async kvGet<T>(key: string): Promise<T | null> {
    const rows = await this.rest<Array<{ value: T }>>(
      "GET",
      "kv",
      `select=value&key=eq.${enc(key)}&limit=1`
    );
    return rows?.[0]?.value ?? null;
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    await this.rest(
      "POST",
      "kv",
      "on_conflict=key",
      [{ key, value, updated_at: new Date().toISOString() }],
      "resolution=merge-duplicates,return=minimal"
    );
  }

  async recordPublication(
    kind: string,
    refId: string | null,
    channelId: string,
    messageId: string
  ): Promise<void> {
    await this.rest(
      "POST",
      "publications",
      "",
      [{ kind, ref_id: refId, channel_id: channelId, discord_message_id: messageId }],
      "return=minimal"
    );
  }
}
