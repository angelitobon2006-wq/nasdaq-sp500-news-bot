import {
  buildSummaryPrompt,
  parseSummary,
  SUMMARY_SYSTEM_PROMPT,
} from "../analysis.js";
import { computeBias } from "../bias.js";
import { askClaude, EST_TOKENS_PER_CALL, getBudget, type Deps } from "../deps.js";
import { summaryEmbed } from "../format.js";
import type { EconomicEvent, NewsRow, SummaryData } from "../types.js";
import { errMsg, floorHour, formatMadrid, madridHour, minutesAgoISO } from "../util.js";

const EMPTY_SUMMARY: SummaryData = {
  hay_noticias: false,
  resumen: "",
  noticias_importantes: [],
  factores_alcistas: [],
  factores_bajistas: [],
  sesgo_nasdaq: "NEUTRAL",
  motivo_nasdaq: "",
  sesgo_sp500: "NEUTRAL",
  motivo_sp500: "",
};

/** Resumen calculado sin IA a partir de los análisis ya guardados (plan B gratuito). */
export function fallbackSummary(rows: NewsRow[]): SummaryData {
  const bias = computeBias(rows);
  const rank = { ALTO: 0, MEDIO: 1, BAJO: 2 } as const;
  const sorted = [...rows].sort(
    (a, b) => rank[a.analysis?.impacto ?? "BAJO"] - rank[b.analysis?.impacto ?? "BAJO"]
  );
  const up = sorted.filter((r) => r.analysis?.conclusion === "ALCISTA");
  const down = sorted.filter((r) => r.analysis?.conclusion === "BAJISTA");
  return {
    hay_noticias: true,
    resumen: `Resumen automático sin IA: ${rows.length} noticia${rows.length === 1 ? "" : "s"} relevante${rows.length === 1 ? "" : "s"} en la última hora.`,
    noticias_importantes: sorted.slice(0, 5).map((r) => ({
      titular: r.analysis?.titular_es ?? r.title,
      impacto: r.analysis?.impacto ?? "MEDIO",
      por_que: r.analysis?.motivo_impacto ?? "",
    })),
    factores_alcistas: up.slice(0, 4).map((r) => r.analysis?.titular_es ?? r.title),
    factores_bajistas: down.slice(0, 4).map((r) => r.analysis?.titular_es ?? r.title),
    sesgo_nasdaq: bias.nasdaq.label,
    motivo_nasdaq: `Puntuación ${bias.nasdaq.score >= 0 ? "+" : ""}${bias.nasdaq.score} según los análisis de la hora.`,
    sesgo_sp500: bias.sp500.label,
    motivo_sp500: `Puntuación ${bias.sp500.score >= 0 ? "+" : ""}${bias.sp500.score} según los análisis de la hora.`,
  };
}

export interface BuiltSummary {
  summary: SummaryData;
  upcoming: EconomicEvent[];
  usedClaude: boolean;
  importantCount: number;
}

/** Construye el resumen de la última hora. Solo llama a Claude si hay noticias importantes. */
export async function buildSummary(
  deps: Deps,
  opts: { allowClaude: boolean; kind?: "summary" | "manual" } = { allowClaude: true }
): Promise<BuiltSummary> {
  const now = deps.now();
  const rows = await deps.db.analysesSince(minutesAgoISO(now, 60));
  const important = rows.filter((r) => r.analysis?.relevante && r.analysis.impacto !== "BAJO");
  const upcoming = await deps.db.upcomingEvents(
    now.toISOString(),
    new Date(now.getTime() + 12 * 3_600_000).toISOString(),
    ["ALTO", "MEDIO"]
  );

  if (important.length === 0) {
    return { summary: { ...EMPTY_SUMMARY }, upcoming, usedClaude: false, importantCount: 0 };
  }

  if (opts.allowClaude) {
    const budget = await getBudget(deps);
    if (budget.tokensLeft >= EST_TOKENS_PER_CALL) {
      try {
        const res = await askClaude(deps, opts.kind ?? "summary", {
          system: SUMMARY_SYSTEM_PROMPT,
          user: buildSummaryPrompt(important, now),
          maxTokens: 1200,
        });
        return {
          summary: parseSummary(res.text),
          upcoming,
          usedClaude: true,
          importantCount: important.length,
        };
      } catch (e) {
        console.error("Resumen con IA fallido, uso el plan B:", errMsg(e));
      }
    }
  }
  return {
    summary: fallbackSummary(important),
    upcoming,
    usedClaude: false,
    importantCount: important.length,
  };
}

export interface SummaryStats {
  skipped?: string;
  posted: boolean;
  usedClaude: boolean;
  importantCount: number;
}

/** Resumen horario. Una sola publicación por hora aunque GitHub lo ejecute dos veces. */
export async function runSummaryJob(deps: Deps): Promise<SummaryStats> {
  const now = deps.now();
  const stats: SummaryStats = { posted: false, usedClaude: false, importantCount: 0 };

  const hour = madridHour(now);
  const { summaryStartHour: a, summaryEndHour: b } = deps.settings;
  const inside = a <= b ? hour >= a && hour <= b : hour >= a || hour <= b;
  if (!inside) {
    stats.skipped = `Fuera del horario del resumen (${hour}h en Madrid)`;
    return stats;
  }

  const bucket = floorHour(now).toISOString();
  if (!(await deps.db.tryStartJob("summary", bucket))) {
    stats.skipped = "El resumen de esta hora ya se había ejecutado";
    return stats;
  }

  try {
    if (!(await deps.db.claimSummary(bucket))) {
      stats.skipped = "El resumen de esta hora ya existe";
      await deps.db.finishJob("summary", bucket, "ok", { ...stats });
      return stats;
    }

    const built = await buildSummary(deps, { allowClaude: true, kind: "summary" });
    stats.usedClaude = built.usedClaude;
    stats.importantCount = built.importantCount;

    if (!built.summary.hay_noticias && !deps.settings.summaryPostWhenEmpty) {
      await deps.db.saveSummary(bucket, built.summary, null);
      stats.skipped = "Sin noticias relevantes y SUMMARY_POST_WHEN_EMPTY=false";
    } else {
      if (!deps.channelId) throw new Error("Falta DISCORD_CHANNEL_ID");
      const label = formatMadrid(floorHour(now), "time");
      const messageId = await deps.discord.postMessage(deps.channelId, {
        embeds: [summaryEmbed(built.summary, built.upcoming, label)],
      });
      await deps.db.saveSummary(bucket, built.summary, messageId);
      await deps.db
        .recordPublication("summary", bucket, deps.channelId, messageId)
        .catch((e) => console.error(errMsg(e)));
      stats.posted = true;
    }
    await deps.db.finishJob("summary", bucket, "ok", { ...stats });
    return stats;
  } catch (e) {
    await deps.db.releaseSummary(bucket).catch(() => undefined);
    await deps.db
      .finishJob("summary", bucket, "error", { ...stats }, errMsg(e))
      .catch(() => undefined);
    throw e;
  }
}
