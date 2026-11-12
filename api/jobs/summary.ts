import { buildDeps } from "../../lib/deps.js";
import { isAuthorizedCron, json } from "../../lib/http.js";
import { runSummaryJob } from "../../lib/jobs/summary.js";
import { errMsg } from "../../lib/util.js";

/** Lo llama GitHub Actions una vez por hora. */
export async function POST(request: Request): Promise<Response> {
  if (!isAuthorizedCron(request)) return json({ ok: false, error: "No autorizado" }, 401);
  try {
    const stats = await runSummaryJob(buildDeps());
    return json({ ok: true, stats });
  } catch (e) {
    console.error("Fallo en el resumen horario:", errMsg(e));
    return json({ ok: false, error: errMsg(e) }, 500);
  }
}
