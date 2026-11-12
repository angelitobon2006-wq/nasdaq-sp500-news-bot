import { buildDeps } from "../../lib/deps.js";
import { isAuthorizedCron, json } from "../../lib/http.js";
import { runCalendarJob } from "../../lib/jobs/calendar.js";
import { errMsg } from "../../lib/util.js";

/** Lo llama GitHub Actions cada ~5 minutos: refresca el calendario y envía alertas. */
export async function POST(request: Request): Promise<Response> {
  if (!isAuthorizedCron(request)) return json({ ok: false, error: "No autorizado" }, 401);
  try {
    const stats = await runCalendarJob(buildDeps());
    return json({ ok: true, stats });
  } catch (e) {
    console.error("Fallo en el calendario:", errMsg(e));
    return json({ ok: false, error: errMsg(e) }, 500);
  }
}
