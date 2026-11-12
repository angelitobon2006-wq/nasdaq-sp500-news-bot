import type {
  Analysis,
  Direction,
  Embed,
  EconomicEvent,
  Impact,
  MarketBias,
  Scenario,
  SummaryData,
} from "./types.js";
import type { BiasResult } from "./bias.js";
import { formatMadrid, truncate } from "./util.js";

export const COLORS = {
  ALTO: 0xe74c3c,
  MEDIO: 0xf1c40f,
  BAJO: 0x95a5a6,
  RESUMEN: 0x2f5cff,
  CALENDARIO: 0x3498db,
  ALERTA: 0xe67e22,
  ESTADO: 0x2ecc71,
} as const;

const DISCLAIMER = "Análisis automático con IA · No es consejo financiero";

export const IMPACT_LABEL: Record<Impact, string> = {
  ALTO: "🔴 ALTO IMPACTO",
  MEDIO: "🟠 IMPACTO MEDIO",
  BAJO: "⚪ BAJO IMPACTO",
};

const DIRECTION_EMOJI: Record<MarketBias, string> = {
  ALCISTA: "🟢 ALCISTA",
  BAJISTA: "🔴 BAJISTA",
  NEUTRAL: "⚪ NEUTRAL",
  MIXTO: "🟡 MIXTO",
  NO_AFECTA: "➖ No le afecta",
};

export const directionLabel = (d: MarketBias): string => DIRECTION_EMOJI[d];

const MARKET_TEXT = { NASDAQ: "Nasdaq 100 (NQ/MNQ)", SP500: "S&P 500 (ES/MES)" } as const;

function bullets(items: string[]): string {
  return items.map((x) => `• ${x}`).join("\n");
}

function scenarioText(s: Scenario | null, max = 1000): string {
  if (!s) return "No aplica.";
  const parts = [s.que_favorece];
  if (s.factores.length) parts.push(`**Factores:**\n${bullets(s.factores)}`);
  if (s.confirmacion.length) parts.push(`**Confirmación a esperar:**\n${bullets(s.confirmacion)}`);
  return truncate(parts.filter(Boolean).join("\n"), max);
}

/** Recorta un embed para respetar los límites de Discord (6000 caracteres en total). */
export function fitEmbed(e: Embed): Embed {
  const out: Embed = {
    ...e,
    title: e.title ? truncate(e.title, 256) : undefined,
    description: e.description ? truncate(e.description, 4000) : undefined,
    fields: (e.fields ?? []).slice(0, 25).map((f) => ({
      ...f,
      name: truncate(f.name, 256) || "—",
      value: truncate(f.value, 1024) || "—",
    })),
    footer: e.footer ? { text: truncate(e.footer.text, 2048) } : undefined,
  };

  const total = (): number =>
    (out.title?.length ?? 0) +
    (out.description?.length ?? 0) +
    (out.footer?.text.length ?? 0) +
    (out.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

  let guard = 0;
  while (total() > 5800 && guard++ < 500) {
    const fields = out.fields ?? [];
    const longest = fields.reduce(
      (best, f, i) => (f.value.length > (fields[best]?.value.length ?? 0) ? i : best),
      0
    );
    if (fields[longest] && fields[longest].value.length > 200) {
      fields[longest].value = truncate(
        fields[longest].value,
        Math.floor(fields[longest].value.length * 0.8)
      );
    } else if (out.description && out.description.length > 300) {
      out.description = truncate(out.description, Math.floor(out.description.length * 0.8));
    } else {
      break;
    }
  }
  return out;
}

export interface NewsMeta {
  url?: string;
  source: string;
  publishedAt?: string | null;
}

export function newsEmbed(a: Analysis, meta: NewsMeta): Embed {
  const mercados = a.mercados.map((m) => MARKET_TEXT[m]).join(" · ");
  const fuente = meta.url ? `[${meta.source}](${meta.url})` : meta.source;

  // Bajo impacto: formato resumido, sin escenarios ni operativa
  if (a.impacto === "BAJO") {
    return fitEmbed({
      title: `⚪ ${a.titular_es}`,
      url: meta.url,
      color: COLORS.BAJO,
      description: [
        `**${IMPACT_LABEL.BAJO}** · ${mercados}`,
        truncate(a.que_ha_ocurrido, 350),
        a.motivo_impacto ? `*${truncate(a.motivo_impacto, 200)}*` : "",
        `Fuente: ${fuente}`,
      ]
        .filter(Boolean)
        .join("\n"),
      footer: { text: DISCLAIMER },
      timestamp: meta.publishedAt ?? undefined,
    });
  }

  const emoji = a.impacto === "ALTO" ? "🔴" : "🟠";
  return fitEmbed({
    title: `${emoji} ${a.titular_es}`,
    url: meta.url,
    color: COLORS[a.impacto],
    description: [
      `**${IMPACT_LABEL[a.impacto]}** · ${mercados}`,
      a.motivo_impacto ? `*${a.motivo_impacto}*` : "",
      "",
      "**Qué ha ocurrido**",
      a.que_ha_ocurrido,
    ]
      .filter((x) => x !== undefined)
      .join("\n"),
    fields: [
      {
        name: "📚 Contexto económico",
        value: `${a.contexto || "—"}${a.descontado ? `\n**¿Descontado?** ${a.descontado}` : ""}`,
      },
      { name: "📈 Nasdaq 100 (NQ/MNQ)", value: a.repercusion_nasdaq || "—" },
      { name: "📊 S&P 500 (ES/MES)", value: a.repercusion_sp500 || "—" },
      { name: "🟢 Escenario alcista", value: scenarioText(a.escenario_alcista) },
      { name: "🔴 Escenario bajista", value: scenarioText(a.escenario_bajista) },
      { name: "Sesgo predominante", value: DIRECTION_EMOJI[a.conclusion], inline: true },
      { name: "Confianza", value: a.confianza, inline: true },
      { name: "Fuente", value: fuente, inline: true },
    ],
    footer: { text: DISCLAIMER },
    timestamp: meta.publishedAt ?? undefined,
  });
}

const EVENT_EMOJI: Record<Impact, string> = { ALTO: "🔴", MEDIO: "🟠", BAJO: "⚪" };

function eventLine(e: EconomicEvent): string {
  return (
    `${EVENT_EMOJI[e.impact]} **${formatMadrid(e.event_time)}** · ${e.title}\n` +
    `   Previsión: ${e.forecast ?? "—"} · Anterior: ${e.previous ?? "—"} · Publicado: ${e.actual ?? "no disponible"}`
  );
}

export function calendarEmbed(events: EconomicEvent[], days: number): Embed {
  const lines = events.map(eventLine);
  let description = lines.join("\n");
  if (description.length > 3600) {
    const kept: string[] = [];
    let len = 0;
    for (const l of lines) {
      if (len + l.length + 1 > 3500) break;
      kept.push(l);
      len += l.length + 1;
    }
    description = `${kept.join("\n")}\n… y ${lines.length - kept.length} más.`;
  }
  return fitEmbed({
    title: `📅 Calendario económico · próximos ${days} día${days === 1 ? "" : "s"} (hora de Madrid)`,
    description:
      events.length === 0
        ? "No hay eventos de impacto medio/alto guardados para este periodo. La fuente gratuita se actualiza cada hora y puede tardar en publicar la semana siguiente."
        : description,
    color: COLORS.CALENDARIO,
    footer: {
      text: "Fuente gratuita no oficial (Faireconomy). Puede haber errores o retrasos; confirma en el BLS, la Fed o tu plataforma.",
    },
  });
}

export function alertEmbed(group: EconomicEvent[], minutes: number): Embed {
  const first = group[0];
  return fitEmbed({
    title: `⏰ En ~${minutes} min: ${first.category ?? first.title}`,
    description: [
      `**${formatMadrid(first.event_time)}** (hora de Madrid) · ${IMPACT_LABEL[first.impact]}`,
      "",
      ...group.map(
        (e) =>
          `**${e.title}**\nPrevisión: ${e.forecast ?? "—"} · Anterior: ${e.previous ?? "—"} · Publicado: ${e.actual ?? "pendiente"}`
      ),
      "",
      "Se esperan picos de volatilidad en NQ/MNQ y ES/MES. La reacción depende de la sorpresa frente a la previsión.",
    ].join("\n"),
    color: COLORS.ALERTA,
    footer: { text: "Alerta automática · No es consejo financiero" },
  });
}

export function summaryEmbed(
  s: SummaryData,
  upcoming: EconomicEvent[],
  hourLabel: string
): Embed {
  const fields: NonNullable<Embed["fields"]> = [];

  if (s.hay_noticias) {
    if (s.noticias_importantes.length) {
      fields.push({
        name: "📰 Noticias importantes de la última hora",
        value: s.noticias_importantes
          .map((n) => `• ${n.impacto === "ALTO" ? "🔴" : n.impacto === "MEDIO" ? "🟠" : "⚪"} **${n.titular}** — ${n.por_que}`)
          .join("\n"),
      });
    }
    fields.push(
      {
        name: "🟢 Factores alcistas",
        value: s.factores_alcistas.length ? bullets(s.factores_alcistas) : "Sin factores claros.",
        inline: true,
      },
      {
        name: "🔴 Factores bajistas",
        value: s.factores_bajistas.length ? bullets(s.factores_bajistas) : "Sin factores claros.",
        inline: true,
      },
      {
        name: "📈 Sesgo fundamental Nasdaq 100",
        value: `${DIRECTION_EMOJI[s.sesgo_nasdaq]}${s.motivo_nasdaq ? `\n${s.motivo_nasdaq}` : ""}`,
      },
      {
        name: "📊 Sesgo fundamental S&P 500",
        value: `${DIRECTION_EMOJI[s.sesgo_sp500]}${s.motivo_sp500 ? `\n${s.motivo_sp500}` : ""}`,
      }
    );
  }

  fields.push({
    name: "📅 Próximos acontecimientos",
    value: upcoming.length
      ? upcoming
          .slice(0, 6)
          .map((e) => `${EVENT_EMOJI[e.impact]} ${formatMadrid(e.event_time)} · ${e.title}`)
          .join("\n")
      : "No hay eventos de impacto medio/alto en las próximas horas.",
  });

  return fitEmbed({
    title: `🕐 Resumen horario · ${hourLabel} (Madrid)`,
    description: s.hay_noticias
      ? s.resumen
      : "No ha habido noticias relevantes para Nasdaq 100 ni S&P 500 en la última hora.",
    color: COLORS.RESUMEN,
    fields,
    footer: { text: DISCLAIMER },
  });
}

export function biasEmbed(b: BiasResult, hours: number): Embed {
  const line = (name: string, m: BiasResult["nasdaq"]): string =>
    `**${name}:** ${DIRECTION_EMOJI[m.label]}\nPuntuación ${m.score >= 0 ? "+" : ""}${m.score} (alcista ${m.up.toFixed(1)} · bajista ${m.down.toFixed(1)}) · ${m.count} análisis`;
  return fitEmbed({
    title: `🧭 Sesgo fundamental · últimas ${hours} h`,
    description:
      b.analyzed === 0
        ? "No hay análisis recientes con los que calcular un sesgo."
        : `${line("Nasdaq 100 (NQ/MNQ)", b.nasdaq)}\n\n${line("S&P 500 (ES/MES)", b.sp500)}`,
    color: COLORS.RESUMEN,
    footer: {
      text: "Resumen de las noticias analizadas (ponderadas por impacto y confianza). No es una señal de entrada.",
    },
  });
}

export function directionFromBias(d: Direction): string {
  return DIRECTION_EMOJI[d];
}
