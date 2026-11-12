import { createGroq } from "./groq.js";
import { createClaude, type Llm, type LlmRequest, type LlmResult } from "./anthropic.js";
import { env, loadSettings, requireEnv, type Settings } from "./config.js";
import { SupabaseDb, type Db, type UsageToday } from "./db.js";
import { createDiscord, type DiscordPoster } from "./discord.js";
import { newsEmbed } from "./format.js";
import type { Analysis, NewsRow } from "./types.js";
import { errMsg, startOfMadridDayISO } from "./util.js";

/** Todo lo que necesitan los trabajos; se puede sustituir en las pruebas. */
export interface Deps {
  db: Db;
  llm: Llm;
  discord: DiscordPoster;
  settings: Settings;
  channelId: string;
  fetchImpl: typeof fetch;
  now: () => Date;
}

/**
 * Construye las dependencias reales. Las claves de Anthropic y Discord se leen
 * solo cuando hacen falta, así cada endpoint exige únicamente lo que usa.
 */
export function buildDeps(): Deps {
  const settings = loadSettings();
  const db = new SupabaseDb(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const llm: Llm = {
    complete: (req) =>
      settings.provider === "anthropic"
        ? createClaude(requireEnv("ANTHROPIC_API_KEY"), settings.model).complete(req)
        : createGroq(requireEnv("GROQ_API_KEY"), settings.model).complete(req),
  };
  const discord: DiscordPoster = {
    postMessage: (channelId, payload) =>
      createDiscord(requireEnv("DISCORD_BOT_TOKEN")).postMessage(channelId, payload),
  };
  return {
    db,
    llm,
    discord,
    settings,
    channelId: env("DISCORD_CHANNEL_ID") ?? "",
    fetchImpl: fetch,
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------
//  Control de gasto de Claude
// ---------------------------------------------------------------

/** Estimación prudente de tokens por análisis (entrada + salida) para frenar a tiempo. */
export const EST_TOKENS_PER_CALL = 2_500;

export type UsageKind = "news" | "summary" | "manual";

/** Llama a Claude y registra siempre el consumo, aunque luego falle el análisis. */
export async function askClaude(
  deps: Deps,
  kind: UsageKind,
  req: LlmRequest
): Promise<LlmResult> {
  const res = await deps.llm.complete(req);
  try {
    await deps.db.addUsage(kind, res.model, res.inputTokens, res.outputTokens);
  } catch (e) {
    console.error("No se pudo registrar el consumo:", errMsg(e));
  }
  return res;
}

export interface BudgetState {
  usage: UsageToday;
  tokensLeft: number;
  newsLeft: number;
  manualLeft: number;
}

export async function getBudget(deps: Deps): Promise<BudgetState> {
  const usage = await deps.db.usageToday(startOfMadridDayISO(deps.now()));
  const s = deps.settings;
  return {
    usage,
    tokensLeft: Math.max(0, s.dailyTokenBudget - usage.tokens),
    newsLeft: Math.max(0, s.maxAnalysesPerDay - usage.newsAnalyses),
    manualLeft: Math.max(0, s.manualAnalysesPerDay - usage.manualAnalyses),
  };
}

// ---------------------------------------------------------------
//  Publicación de una noticia analizada
// ---------------------------------------------------------------

export async function publishNews(
  deps: Deps,
  row: NewsRow,
  analysis: Analysis
): Promise<boolean> {
  try {
    if (!deps.channelId) throw new Error("Falta DISCORD_CHANNEL_ID");
    const messageId = await deps.discord.postMessage(deps.channelId, {
      embeds: [
        newsEmbed(analysis, {
          url: row.url,
          source: row.source,
          publishedAt: row.published_at,
        }),
      ],
    });
    // Si el guardado falla, reintentamos una vez para no repetir la publicación
    for (let i = 0; i < 2; i++) {
      try {
        await deps.db.markPublished(row.id, messageId);
        break;
      } catch (e) {
        if (i === 1) console.error("No se pudo marcar como publicada:", errMsg(e));
      }
    }
    await deps.db
      .recordPublication("news", row.id, deps.channelId, messageId)
      .catch((e) => console.error(errMsg(e)));
    return true;
  } catch (e) {
    console.error("No se pudo publicar en Discord:", errMsg(e));
    return false;
  }
}
