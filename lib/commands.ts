import { buildNewsPrompt, NEWS_SYSTEM_PROMPT, parseAnalysis } from "./analysis.js";
import { computeBias } from "./bias.js";
import { askClaude, EST_TOKENS_PER_CALL, getBudget, type Deps } from "./deps.js";
import {
  editOriginalResponse,
  type Interaction,
  type MessagePayload,
} from "./discord.js";
import {
  biasEmbed,
  calendarEmbed,
  COLORS,
  fitEmbed,
  newsEmbed,
  summaryEmbed,
} from "./format.js";
import { buildSummary } from "./jobs/summary.js";
import type { Embed } from "./types.js";
import {
  errMsg,
  formatMadrid,
  minutesAgoISO,
  startOfMadridDayISO,
  truncate,
} from "./util.js";

export interface InteractionResult {
  status: number;
  body: unknown;
}

export type EditFn = (
  applicationId: string,
  token: string,
  payload: MessagePayload
) => Promise<void>;

const EPHEMERAL = 64;

const immediate = (content: string): InteractionResult => ({
  status: 200,
  body: { type: 4, data: { content, flags: EPHEMERAL } },
});

function option(interaction: Interaction, name: string): string | number | boolean | undefined {
  return interaction.data?.options?.find((o) => o.name === name)?.value;
}

/**
 * Atiende una interacción de Discord. Los comandos tardan más de 3 segundos en el peor caso,
 * así que se responde al instante con "pensando..." y la respuesta real se envía después
 * en segundo plano (schedule = waitUntil de Vercel).
 */
export async function handleInteraction(
  interaction: Interaction,
  deps: Deps,
  schedule: (p: Promise<unknown>) => void,
  edit: EditFn = editOriginalResponse
): Promise<InteractionResult> {
  if (interaction.type === 1) return { status: 200, body: { type: 1 } };
  if (interaction.type !== 2) return { status: 400, body: { error: "Tipo no soportado" } };

  if (!interaction.guild_id) return immediate("Usa este comando dentro del servidor.");
  if (deps.settings.guildId && interaction.guild_id !== deps.settings.guildId) {
    return immediate("Este bot solo funciona en el servidor configurado.");
  }

  const name = interaction.data?.name ?? "";
  const handlers: Record<string, (i: Interaction, d: Deps) => Promise<MessagePayload>> = {
    estado: cmdEstado,
    resumen: cmdResumen,
    analizar: cmdAnalizar,
    calendario: cmdCalendario,
    sesgo: cmdSesgo,
  };
  const handler = handlers[name];
  if (!handler) return immediate("Comando desconocido.");

  const isPublic = name === "analizar";
  schedule(
    (async () => {
      let payload: MessagePayload;
      try {
        payload = await handler(interaction, deps);
      } catch (e) {
        console.error(`Error en /${name}:`, errMsg(e));
        payload = {
          content: `⚠️ Algo ha fallado en /${name}: ${truncate(errMsg(e), 200)}\nInténtalo de nuevo en un minuto.`,
        };
      }
      try {
        await edit(interaction.application_id, interaction.token, payload);
      } catch (e) {
        console.error("No se pudo responder al comando:", errMsg(e));
      }
    })()
  );

  return {
    status: 200,
    body: { type: 5, data: isPublic ? {} : { flags: EPHEMERAL } },
  };
}

// ---------------------------------------------------------------
//  Esperas entre usos (para que nadie gaste la IA a base de comandos)
// ---------------------------------------------------------------

async function cooldownRemaining(deps: Deps, key: string, seconds: number): Promise<number> {
  const last = await deps.db.kvGet<{ at: string }>(key);
  if (!last) return 0;
  const left = seconds - (deps.now().getTime() - Date.parse(last.at)) / 1000;
  return left > 0 ? Math.ceil(left) : 0;
}

const startCooldown = (deps: Deps, key: string): Promise<void> =>
  deps.db.kvSet(key, { at: deps.now().toISOString() });

// ---------------------------------------------------------------
//  Comandos
// ---------------------------------------------------------------

function ago(iso: string | null | undefined, now: Date): string {
  if (!iso) return "nunca";
  const min = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (min < 1) return "hace menos de 1 min";
  if (min < 90) return `hace ${min} min`;
  return `hace ${Math.round(min / 60)} h`;
}

async function cmdEstado(_i: Interaction, deps: Deps): Promise<MessagePayload> {
  const now = deps.now();
  const since = startOfMadridDayISO(now);
  const [runs, counts, budget, feeds, cal] = await Promise.all([
    deps.db.lastJobRuns(),
    deps.db.statusCounts(since),
    getBudget(deps),
    deps.db.kvGet<{ at: string; health: Record<string, { ok: boolean; error?: string }> }>(
      "feed_health"
    ),
    deps.db.kvGet<{ at: string; count: number; errors?: string[] }>("calendar_refresh"),
  ]);

  const lastByJob = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!lastByJob.has(r.job)) lastByJob.set(r.job, r);
  const jobLines = ["news", "summary", "calendar"].map((j) => {
    const r = lastByJob.get(j);
    if (!r) return `• **${j}**: sin ejecuciones todavía`;
    const icon = r.status === "ok" ? "✅" : r.status === "error" ? "❌" : "⏳";
    return `• ${icon} **${j}**: ${ago(r.started_at, now)}${r.error ? ` — ${truncate(r.error, 80)}` : ""}`;
  });

  const feedEntries = Object.entries(feeds?.health ?? {});
  const feedFails = feedEntries.filter(([, h]) => !h.ok).map(([id]) => id);

  const embed: Embed = fitEmbed({
    title: "🩺 Estado del bot de noticias",
    color: COLORS.ESTADO,
    fields: [
      { name: "⚙️ Últimas ejecuciones", value: jobLines.join("\n") },
      {
        name: "📰 Noticias de hoy",
        value:
          `Publicadas: **${counts.published ?? 0}** · Analizadas sin publicar: ${(counts.analyzed ?? 0) + (counts.archived ?? 0)}\n` +
          `Descartadas por irrelevantes: ${counts.skipped ?? 0} · Con error: ${counts.failed ?? 0}`,
      },
      {
        name: "🤖 Consumo de Claude hoy",
        value:
          `Tokens: **${budget.usage.tokens.toLocaleString("es-ES")}** / ${deps.settings.dailyTokenBudget.toLocaleString("es-ES")}\n` +
          `Análisis de noticias: ${budget.usage.newsAnalyses} / ${deps.settings.maxAnalysesPerDay}\n` +
          `Análisis manuales: ${budget.usage.manualAnalyses} / ${deps.settings.manualAnalysesPerDay} · Resúmenes: ${budget.usage.summaries}`,
      },
      {
        name: "📡 Fuentes RSS",
        value: feeds
          ? `${feedEntries.length - feedFails.length}/${feedEntries.length} funcionando (${ago(feeds.at, now)})${feedFails.length ? `\nCaídas: ${feedFails.join(", ")}` : ""}`
          : "Sin datos todavía.",
      },
      {
        name: "📅 Calendario",
        value: cal
          ? `Última actualización ${ago(cal.at, now)} · ${cal.count} eventos${cal.errors?.length ? `\n⚠️ ${truncate(cal.errors.join("; "), 200)}` : ""}`
          : "Sin datos todavía.",
      },
    ],
    footer: { text: "Los límites diarios se reinician a medianoche (hora de Madrid)" },
  });
  return { embeds: [embed] };
}

async function cmdResumen(i: Interaction, deps: Deps): Promise<MessagePayload> {
  const now = deps.now();
  const refresh = option(i, "actualizar") === true;

  if (!refresh) {
    const latest = await deps.db.latestSummary();
    if (!latest) {
      return {
        content:
          "Todavía no hay ningún resumen guardado. Usa `/resumen actualizar:True` para generar uno ahora.",
      };
    }
    const upcoming = await deps.db.upcomingEvents(
      now.toISOString(),
      new Date(now.getTime() + 12 * 3_600_000).toISOString(),
      ["ALTO", "MEDIO"]
    );
    return {
      content: `Último resumen guardado (${formatMadrid(latest.created_at)}).`,
      embeds: [summaryEmbed(latest.summary, upcoming, formatMadrid(latest.bucket, "time"))],
    };
  }

  const wait = await cooldownRemaining(
    deps,
    "cooldown:resumen",
    deps.settings.summaryCooldownSeconds
  );
  if (wait > 0) {
    return { content: `⏳ Espera ${wait} s antes de pedir otro resumen nuevo.` };
  }
  const budget = await getBudget(deps);
  if (budget.tokensLeft < EST_TOKENS_PER_CALL) {
    return { content: "🚫 Se ha alcanzado el presupuesto diario de IA. Inténtalo mañana." };
  }
  await startCooldown(deps, "cooldown:resumen");
  const built = await buildSummary(deps, { allowClaude: true, kind: "manual" });
  return {
    content: built.usedClaude ? "Resumen generado ahora con IA." : "Resumen calculado ahora.",
    embeds: [summaryEmbed(built.summary, built.upcoming, formatMadrid(now, "time"))],
  };
}

async function cmdAnalizar(i: Interaction, deps: Deps): Promise<MessagePayload> {
  const texto = String(option(i, "texto") ?? "").replace(/\s+/g, " ").trim();
  if (texto.length < 30) {
    return { content: "Escribe al menos 30 caracteres: un titular completo o un párrafo." };
  }

  const userId = i.member?.user?.id ?? i.user?.id ?? "desconocido";
  const key = `cooldown:analizar:${userId}`;
  const wait = await cooldownRemaining(deps, key, deps.settings.manualCooldownSeconds);
  if (wait > 0) return { content: `⏳ Espera ${wait} s antes de pedir otro análisis.` };

  const budget = await getBudget(deps);
  if (budget.manualLeft <= 0) {
    return {
      content: `🚫 Se alcanzó el límite diario de ${deps.settings.manualAnalysesPerDay} análisis manuales. Se reinicia a medianoche.`,
    };
  }
  if (budget.tokensLeft < EST_TOKENS_PER_CALL) {
    return { content: "🚫 Se ha alcanzado el presupuesto diario de IA. Inténtalo mañana." };
  }

  await startCooldown(deps, key);
  const now = deps.now();
  const title = truncate(texto, 200);
  const res = await askClaude(deps, "manual", {
    system: NEWS_SYSTEM_PROMPT,
    user: buildNewsPrompt(
      {
        source: "Consulta manual de un usuario",
        publishedAt: now.toISOString(),
        title,
        text: texto,
      },
      deps.settings.maxInputChars,
      now
    ),
    maxTokens: 1400,
  });
  const analysis = parseAnalysis(res.text);

  const note = analysis.relevante
    ? undefined
    : "ℹ️ Este texto no parece afectar de forma razonable al Nasdaq 100 ni al S&P 500.";
  return {
    content: [`Análisis pedido por <@${userId}>.`, note].filter(Boolean).join("\n"),
    embeds: [newsEmbed(analysis, { source: "Consulta manual" })],
  };
}

async function cmdCalendario(i: Interaction, deps: Deps): Promise<MessagePayload> {
  const raw = Number(option(i, "dias") ?? 3);
  const days = Math.min(7, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : 3));
  const now = deps.now();
  const events = await deps.db.upcomingEvents(
    now.toISOString(),
    new Date(now.getTime() + days * 86_400_000).toISOString(),
    ["ALTO", "MEDIO"]
  );
  return { embeds: [calendarEmbed(events, days)] };
}

async function cmdSesgo(_i: Interaction, deps: Deps): Promise<MessagePayload> {
  const hours = 6;
  const rows = await deps.db.analysesSince(minutesAgoISO(deps.now(), hours * 60));
  return { embeds: [biasEmbed(computeBias(rows), hours)] };
}
