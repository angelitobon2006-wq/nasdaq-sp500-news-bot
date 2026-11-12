import { fetchCalendar, groupSimultaneous } from "../calendar.js";
import type { Deps } from "../deps.js";
import { alertEmbed } from "../format.js";
import { errMsg, floorMinutes } from "../util.js";

export interface CalendarStats {
  skipped?: string;
  refreshed: boolean;
  eventsSaved: number;
  sourceErrors: string[];
  alertsSent: number;
  alertErrors: number;
}

const REFRESH_EVERY_MINUTES = 55;

/**
 * Calendario: refresca la fuente como mucho una vez por hora (para no abusar de ella)
 * y avisa de los eventos de ALTO impacto que ocurren dentro de los próximos 30 minutos.
 */
export async function runCalendarJob(deps: Deps): Promise<CalendarStats> {
  const now = deps.now();
  const bucket = floorMinutes(now, 5).toISOString();
  const stats: CalendarStats = {
    refreshed: false,
    eventsSaved: 0,
    sourceErrors: [],
    alertsSent: 0,
    alertErrors: 0,
  };

  if (!(await deps.db.tryStartJob("calendar", bucket))) {
    stats.skipped = "Esta ventana de 5 minutos ya se había ejecutado";
    return stats;
  }

  try {
    // 1. Refresco horario del calendario
    const last = await deps.db.kvGet<{ at: string }>("calendar_refresh");
    const stale =
      !last || now.getTime() - Date.parse(last.at) > REFRESH_EVERY_MINUTES * 60_000;
    if (stale) {
      const { events, errors } = await fetchCalendar(deps.fetchImpl);
      stats.sourceErrors = errors;
      if (events.length) {
        await deps.db.upsertEvents(events);
        stats.refreshed = true;
        stats.eventsSaved = events.length;
      }
      // Se anota siempre el intento: si la fuente falla, no se insiste cada 5 minutos
      await deps.db.kvSet("calendar_refresh", {
        at: now.toISOString(),
        count: events.length,
        errors,
      });
    }

    // 2. Alertas: se reservan de forma atómica y solo después se publican
    const until = new Date(now.getTime() + deps.settings.alertMinutesBefore * 60_000);
    const due = await deps.db.claimDueAlerts(now.toISOString(), until.toISOString());

    for (const group of groupSimultaneous(due)) {
      try {
        if (!deps.channelId) throw new Error("Falta DISCORD_CHANNEL_ID");
        const minutes = Math.max(
          1,
          Math.round((Date.parse(group[0].event_time) - now.getTime()) / 60_000)
        );
        const messageId = await deps.discord.postMessage(deps.channelId, {
          embeds: [alertEmbed(group, minutes)],
        });
        await deps.db
          .recordPublication("calendar_alert", group[0].id, deps.channelId, messageId)
          .catch(() => undefined);
        stats.alertsSent++;
      } catch (e) {
        console.error("No se pudo enviar la alerta:", errMsg(e));
        for (const ev of group) await deps.db.releaseAlert(ev.id).catch(() => undefined);
        stats.alertErrors++;
      }
    }

    await deps.db.finishJob("calendar", bucket, "ok", { ...stats });
    return stats;
  } catch (e) {
    await deps.db
      .finishJob("calendar", bucket, "error", { ...stats }, errMsg(e))
      .catch(() => undefined);
    throw e;
  }
}
