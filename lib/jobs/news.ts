import { buildNewsPrompt, NEWS_SYSTEM_PROMPT, parseAnalysis } from "../analysis.js";
import { askClaude, EST_TOKENS_PER_CALL, getBudget, publishNews, type Deps } from "../deps.js";
import { isNearDuplicate, titleKey, titleTokens } from "../dedupe.js";
import { fetchAllFeeds } from "../feeds.js";
import { scoreItem } from "../relevance.js";
import type { Analysis, FeedItem, NewsRow } from "../types.js";
import {
  errMsg,
  floorMinutes,
  mapLimit,
  minutesAgoISO,
  normalizeUrl,
  sha256,
  truncate,
} from "../util.js";

export interface NewsStats {
  skipped?: string;
  fetched: number;
  tooOld: number;
  duplicates: number;
  fresh: number;
  irrelevant: number;
  nearDuplicates: number;
  candidates: number;
  deferredByLimit: number;
  claimed: number;
  lostRace: number;
  analyzed: number;
  published: number;
  archived: number;
  irrelevantByClaude: number;
  failed: number;
  postFailed: number;
  reposted: number;
  feedsOk: number;
  feedsFailed: number;
  budgetTokensLeft: number;
  budgetNewsLeft: number;
}

const emptyStats = (): NewsStats => ({
  fetched: 0,
  tooOld: 0,
  duplicates: 0,
  fresh: 0,
  irrelevant: 0,
  nearDuplicates: 0,
  candidates: 0,
  deferredByLimit: 0,
  claimed: 0,
  lostRace: 0,
  analyzed: 0,
  published: 0,
  archived: 0,
  irrelevantByClaude: 0,
  failed: 0,
  postFailed: 0,
  reposted: 0,
  feedsOk: 0,
  feedsFailed: 0,
  budgetTokensLeft: 0,
  budgetNewsLeft: 0,
});

/** Comprobación de noticias. Cada ejecución es independiente e idempotente. */
export async function runNewsJob(deps: Deps): Promise<NewsStats> {
  const startedAt = deps.now();
  const bucket = floorMinutes(startedAt, 5).toISOString();
  const stats = emptyStats();

  // Bloqueo: si esta ventana de 5 minutos ya se ejecutó, no se repite.
  if (!(await deps.db.tryStartJob("news", bucket))) {
    stats.skipped = "Esta ventana de 5 minutos ya se había ejecutado";
    return stats;
  }

  try {
    await runNews(deps, stats, startedAt);
    await deps.db.finishJob("news", bucket, "ok", { ...stats });
    return stats;
  } catch (e) {
    await deps.db
      .finishJob("news", bucket, "error", { ...stats }, errMsg(e))
      .catch(() => undefined);
    throw e;
  }
}

async function runNews(deps: Deps, stats: NewsStats, startedAt: Date): Promise<void> {
  const { db, settings } = deps;
  const now = deps.now();

  // 0. Mantenimiento y reenvío de análisis que no llegaron a publicarse
  await db.failStaleProcessing(minutesAgoISO(now, 10));
  await db.expireUnposted(minutesAgoISO(now, 180));
  const pending = await db.unpostedAnalyzed(minutesAgoISO(now, 180), 5);
  for (const row of pending) {
    if (row.analysis && (await publishNews(deps, row, row.analysis))) stats.reposted++;
  }

  // 1. Descarga de fuentes (cada una falla por separado)
  const { items, health } = await fetchAllFeeds(deps.fetchImpl, settings.disabledFeeds);
  stats.fetched = items.length;
  stats.feedsOk = Object.values(health).filter((h) => h.ok).length;
  stats.feedsFailed = Object.values(health).filter((h) => !h.ok).length;
  await db
    .kvSet("feed_health", { at: now.toISOString(), health })
    .catch((e) => console.error(errMsg(e)));

  // 2. Normalización, antigüedad y puntuación (todo sin coste)
  const cutoff = now.getTime() - settings.maxItemAgeHours * 3_600_000;
  const byHash = new Map<string, FeedItem>();
  for (const it of items) {
    const url = normalizeUrl(it.link);
    const urlHash = sha256(url);
    if (byHash.has(urlHash)) continue;

    let published = it.publishedAt ?? now;
    if (published.getTime() > now.getTime()) published = now;
    if (published.getTime() < cutoff) {
      stats.tooOld++;
      continue;
    }
    const rel = scoreItem(it.title, it.summary, it.trust);
    byHash.set(urlHash, {
      urlHash,
      url,
      title: truncate(it.title, 400),
      titleKey: titleKey(it.title),
      summary: truncate(it.summary, 800),
      source: it.feedName,
      publishedAt: published.toISOString(),
      score: rel.score,
    });
  }

  // 3. Deduplicación ANTES de gastar nada: URLs ya vistas
  const existing = await db.existingHashes([...byHash.keys()]);
  const fresh = [...byHash.values()].filter((i) => !existing.has(i.urlHash));
  stats.duplicates = byHash.size - fresh.length;
  stats.fresh = fresh.length;

  // 4. Titulares irrelevantes: se guardan como "omitidos" y nunca llegan a Claude
  const relevant = fresh
    .filter((i) => i.score >= settings.minRelevance)
    .sort(
      (a, b) =>
        b.score - a.score || b.publishedAt.localeCompare(a.publishedAt)
    );
  const irrelevant = fresh.filter((i) => i.score < settings.minRelevance);
  stats.irrelevant = irrelevant.length;
  await db.insertSkipped(irrelevant.slice(0, 300));

  // 5. Titulares casi idénticos (la misma noticia en varias fuentes)
  const recent = (await db.recentTitleKeys(minutesAgoISO(now, 24 * 60), 400)).map((k) =>
    k.split(" ")
  );
  const seen = [...recent];
  const candidates: FeedItem[] = [];
  const nearDup: FeedItem[] = [];
  for (const it of relevant) {
    const tokens = titleTokens(it.title);
    if (isNearDuplicate(tokens, seen)) {
      nearDup.push(it);
      continue;
    }
    candidates.push(it);
    seen.push(tokens);
  }
  stats.nearDuplicates = nearDup.length;
  stats.candidates = candidates.length;
  await db.insertSkipped(nearDup);

  // 6. Límites de gasto: por ejecución, por día y de tokens
  const budget = await getBudget(deps);
  stats.budgetTokensLeft = budget.tokensLeft;
  stats.budgetNewsLeft = budget.newsLeft;
  const byTokens = Math.floor(budget.tokensLeft / EST_TOKENS_PER_CALL);
  let allowed = Math.min(settings.maxAnalysesPerRun, budget.newsLeft, byTokens);
  // Si ya llevamos mucho tiempo (fuentes lentas), no arrancamos análisis nuevos
  if (deps.now().getTime() - startedAt.getTime() > 35_000) allowed = 0;

  const batch = candidates.slice(0, Math.max(0, allowed));
  stats.deferredByLimit = candidates.length - batch.length;

  // 7. Reserva atómica: solo procesamos las filas que ESTA ejecución consiguió insertar
  const claimed = await db.claimNewItems(batch);
  stats.claimed = claimed.length;
  stats.lostRace = batch.length - claimed.length;

  // 8. Análisis y publicación (3 en paralelo como máximo)
  await mapLimit(claimed, 3, (row) => processRow(deps, row, stats));
}

async function processRow(deps: Deps, row: NewsRow, stats: NewsStats): Promise<void> {
  const { db, settings } = deps;

  let analysis: Analysis;
  try {
    const res = await askClaude(deps, "news", {
      system: NEWS_SYSTEM_PROMPT,
      user: buildNewsPrompt(
        {
          source: row.source,
          publishedAt: row.published_at ?? "",
          title: row.title,
          text: row.summary,
          url: row.url,
        },
        settings.maxInputChars,
        deps.now()
      ),
      maxTokens: 1400,
    });
    analysis = parseAnalysis(res.text);
  } catch (e) {
    await db.markFailed(row.id, errMsg(e)).catch(() => undefined);
    stats.failed++;
    return;
  }
  stats.analyzed++;

  if (!analysis.relevante) {
    await db.markSkipped(row.id, analysis);
    stats.irrelevantByClaude++;
    return;
  }
  if (analysis.impacto === "BAJO" && !settings.postLowImpact) {
    await db.markArchived(row.id, analysis);
    stats.archived++;
    return;
  }

  await db.saveAnalysis(row.id, analysis);
  if (await publishNews(deps, row, analysis)) stats.published++;
  else stats.postFailed++;
}
