import { buildDeps } from "../../lib/deps.js";
import { isAuthorizedCron, json } from "../../lib/http.js";
import { runNewsJob } from "../../lib/jobs/news.js";
import { errMsg } from "../../lib/util.js";

/** Lo llama GitHub Actions cada ~5 minutos. */
export async function POST(request: Request): Promise<Response> {
  if (!isAuthorizedCron(request)) return json({ ok: false, error: "No autorizado" }, 401);
  try {
    const stats = await runNewsJob(buildDeps());
    return json({ ok: true, stats });
  } catch (e) {
    console.error("Fallo en el trabajo de noticias:", errMsg(e));
    return json({ ok: false, error: errMsg(e) }, 500);
  }
}
