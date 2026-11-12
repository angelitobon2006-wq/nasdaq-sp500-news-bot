import { test } from "node:test";
import assert from "node:assert/strict";
import { runNewsJob } from "../lib/jobs/news.js";
import { runSummaryJob } from "../lib/jobs/summary.js";
import { runCalendarJob } from "../lib/jobs/calendar.js";
import { handleInteraction } from "../lib/commands.js";
import type { Interaction } from "../lib/discord.js";
import { FakeLlm, analysisJson, makeHarness, rss, rssItem } from "./helpers.js";

const START = "2026-11-04T14:03:00Z";
const NOW = new Date(START);
const T = (n: number) => `Fed holds interest rates steady as inflation data ${n} surprises Treasury yields`;
const feed = (...titles: string[]) =>
  rss(...titles.map((t, i) => rssItem(t, `https://news.example.com/${encodeURIComponent(t)}-${i}`, 5, NOW)));

test("noticias: publica una vez y no repite aunque el workflow corra dos veces", async () => {
  const h = makeHarness({ start: START, xml: feed(T(1)) });
  const a = await runNewsJob(h.deps);
  assert.equal(a.published, 1);
  const b = await runNewsJob(h.deps); // misma ventana de 5 min
  assert.ok(b.skipped);
  h.clock.now = new Date("2026-11-04T14:08:30Z"); // otra ventana, mismas noticias
  const c = await runNewsJob(h.deps);
  assert.equal(c.published, 0);
  assert.equal(h.discord.posts.length, 1);
  assert.equal(h.llm.calls.length, 1);
});

test("noticias: lo irrelevante nunca llega a Claude", async () => {
  const h = makeHarness({ start: START, xml: feed("Celebrity wedding photos released", "Best pizza recipes for the weekend") });
  const s = await runNewsJob(h.deps);
  assert.equal(h.llm.calls.length, 0);
  assert.equal(h.discord.posts.length, 0);
  assert.ok(s.irrelevant >= 1);
});

test("noticias: titulares casi idénticos se analizan una sola vez", async () => {
  const h = makeHarness({
    start: START,
    xml: feed("Fed holds interest rates steady as inflation cools - Reuters", "Fed holds interest rates steady as inflation cools - CNBC"),
  });
  await runNewsJob(h.deps);
  assert.equal(h.llm.calls.length, 1);
});

test("noticias: límite por ejecución (3) y el resto queda para la siguiente", async () => {
  const titles = [1, 2, 3, 4, 5].map((n) => `Nvidia ${["alpha", "bravo", "charlie", "delta", "echo"][n - 1]} chip earnings AI demand ${n * 111} surge`);
  const h = makeHarness({ start: START, xml: feed(...titles) });
  const s = await runNewsJob(h.deps);
  assert.equal(h.llm.calls.length, 3);
  assert.equal(s.published, 3);
  h.clock.now = new Date("2026-11-04T14:08:30Z");
  await runNewsJob(h.deps);
  assert.equal(h.llm.calls.length, 5);
});

test("noticias: tope diario de análisis", async () => {
  const titles = [
    "Fed signals patience on interest rates after jobs report",
    "Nvidia earnings beat estimates as AI chip demand surges",
    "Treasury yields climb ahead of CPI inflation data release",
    "Microsoft Apple Amazon lift Nasdaq futures before bell",
  ];
  const h = makeHarness({ start: START, xml: feed(...titles), env: { MAX_ANALYSES_PER_DAY: "2" } });
  await runNewsJob(h.deps);
  h.clock.now = new Date("2026-11-04T14:08:30Z");
  await runNewsJob(h.deps);
  assert.equal(h.llm.calls.length, 2);
});

test("noticias: si Discord falla, se republica sin gastar otra llamada a Claude", async () => {
  const h = makeHarness({ start: START, xml: feed(T(7)) });
  h.discord.failNext = 1;
  const a = await runNewsJob(h.deps);
  assert.equal(a.published, 0);
  assert.equal(h.llm.calls.length, 1);
  h.clock.now = new Date("2026-11-04T14:08:30Z");
  const b = await runNewsJob(h.deps);
  assert.equal(h.discord.posts.length, 1);
  assert.equal(h.llm.calls.length, 1);
  assert.ok(b.reposted >= 1);
});

test("noticias: si Claude devuelve basura, no se publica ni se reintenta", async () => {
  const h = makeHarness({ start: START, xml: feed(T(8)), llm: new FakeLlm(() => "lo siento, no puedo") });
  const a = await runNewsJob(h.deps);
  assert.equal(a.failed, 1);
  h.clock.now = new Date("2026-11-04T14:08:30Z");
  await runNewsJob(h.deps);
  assert.equal(h.llm.calls.length, 1);
  assert.equal(h.discord.posts.length, 0);
});

test("noticias: relevante=false de Claude no se publica", async () => {
  const h = makeHarness({ start: START, xml: feed(T(9)), llm: new FakeLlm(() => analysisJson({ relevante: false })) });
  await runNewsJob(h.deps);
  assert.equal(h.discord.posts.length, 0);
});

test("noticias: POST_LOW_IMPACT=false guarda el BAJO sin publicar", async () => {
  const h = makeHarness({
    start: START, xml: feed(T(10)), env: { POST_LOW_IMPACT: "false" },
    llm: new FakeLlm(() => analysisJson({ impacto: "BAJO" })),
  });
  await runNewsJob(h.deps);
  assert.equal(h.discord.posts.length, 0);
  assert.equal(h.db.news.filter((r) => r.status === "archived").length, 1);
});

test("noticias: las noticias antiguas se ignoran", async () => {
  const old = rss(rssItem(T(11), "https://old.example.com/a", 60 * 24, NOW));
  const h = makeHarness({ start: START, xml: old });
  await runNewsJob(h.deps);
  assert.equal(h.llm.calls.length, 0);
});

test("resumen horario: una sola vez por hora y aviso si no hay noticias", async () => {
  const h = makeHarness({ start: "2026-11-04T14:02:00Z" });
  const a = await runSummaryJob(h.deps);
  assert.equal(a.posted, true);
  assert.equal(a.usedClaude, false); // sin noticias no se gasta IA
  assert.match(JSON.stringify(h.discord.posts[0].payload), /no hay|sin noticias|Sin noticias/i);
  const b = await runSummaryJob(h.deps);
  assert.ok(b.skipped);
  assert.equal(h.discord.posts.length, 1);
});

test("resumen horario: con noticias usa Claude", async () => {
  const h = makeHarness({ start: START, xml: feed(T(12)) });
  await runNewsJob(h.deps);
  h.llm.respond = () => JSON.stringify({
    resumen: "Fed sin cambios.", noticias_importantes: [{ titular: "Fed", impacto: "ALTO", por_que: "Tipos" }],
    factores_alcistas: ["a"], factores_bajistas: ["b"], sesgo_nasdaq: "ALCISTA", motivo_nasdaq: "x", sesgo_sp500: "NEUTRAL", motivo_sp500: "y",
  });
  h.clock.now = new Date("2026-11-04T15:02:00Z");
  const s = await runSummaryJob(h.deps);
  assert.equal(s.usedClaude, true);
  assert.equal(h.discord.posts.length, 2);
});

const calendar = [
  { title: "CPI m/m", country: "USD", date: "2026-11-04T08:30:00-05:00", impact: "High", forecast: "0.3%", previous: "0.2%", actual: "" },
  { title: "Core CPI m/m", country: "USD", date: "2026-11-04T08:30:00-05:00", impact: "High", forecast: "0.3%", previous: "0.3%", actual: "" },
];

test("calendario: alerta una sola vez 30 min antes y agrupa eventos simultáneos", async () => {
  // 13:30 UTC es la publicación; a las 13:02 faltan 28 min
  const h = makeHarness({ start: "2026-11-04T13:02:00Z", calendar });
  const a = await runCalendarJob(h.deps);
  assert.equal(a.alertsSent, 1); // 1 mensaje que agrupa 2 eventos
  assert.equal(h.discord.posts.length, 1); // un solo mensaje para ambos
  h.clock.now = new Date("2026-11-04T13:07:30Z");
  await runCalendarJob(h.deps);
  assert.equal(h.discord.posts.length, 1);
});

test("calendario: no alerta si falta mucho, y si Discord falla se reintenta", async () => {
  const h = makeHarness({ start: "2026-11-04T11:00:00Z", calendar });
  await runCalendarJob(h.deps);
  assert.equal(h.discord.posts.length, 0);
  h.clock.now = new Date("2026-11-04T13:02:00Z");
  h.discord.failNext = 1;
  await runCalendarJob(h.deps);
  assert.equal(h.discord.posts.length, 0);
  h.clock.now = new Date("2026-11-04T13:07:30Z");
  await runCalendarJob(h.deps);
  assert.equal(h.discord.posts.length, 1);
});

// ---------- comandos ----------
const cmd = (name: string, options: Array<{ name: string; value: string | number | boolean }> = [], user = "u1"): Interaction => ({
  type: 2, application_id: "app", token: "tok", guild_id: "g1", member: { user: { id: user } }, data: { name, options },
});

async function run(h: ReturnType<typeof makeHarness>, i: Interaction) {
  const pending: Promise<unknown>[] = [];
  const edits: unknown[] = [];
  const res = await handleInteraction(i, h.deps, (p) => pending.push(p), async (_a, _t, payload) => void edits.push(payload));
  await Promise.all(pending);
  return { res, edits };
}

test("comandos: PING y respuesta diferida", async () => {
  const h = makeHarness();
  const p = await handleInteraction({ type: 1, application_id: "a", token: "t" }, h.deps, () => {});
  assert.deepEqual(p.body, { type: 1 });
  const { res, edits } = await run(h, cmd("estado"));
  assert.equal((res.body as { type: number }).type, 5);
  assert.equal(edits.length, 1);
});

test("comandos: servidor distinto al configurado se rechaza", async () => {
  const h = makeHarness({ env: { DISCORD_GUILD_ID: "otro" } });
  const { res } = await run(h, cmd("estado"));
  assert.equal((res.body as { type: number }).type, 4);
});

test("/analizar: texto corto rechazado, cooldown por usuario y tope diario", async () => {
  const h = makeHarness({ env: { MANUAL_ANALYSES_PER_DAY: "2", MANUAL_COOLDOWN_SECONDS: "120" } });
  const texto = "La Reserva Federal anunció que mantendrá los tipos de interés sin cambios en su reunión de hoy.";
  let r = await run(h, cmd("analizar", [{ name: "texto", value: "corto" }]));
  assert.equal(h.llm.calls.length, 0);
  assert.ok(r.edits.length === 1);
  await run(h, cmd("analizar", [{ name: "texto", value: texto }]));
  assert.equal(h.llm.calls.length, 1);
  await run(h, cmd("analizar", [{ name: "texto", value: texto }])); // mismo usuario, en cooldown
  assert.equal(h.llm.calls.length, 1);
  h.clock.now = new Date(h.clock.now.getTime() + 200_000);
  await run(h, cmd("analizar", [{ name: "texto", value: texto }]));
  assert.equal(h.llm.calls.length, 2);
  h.clock.now = new Date(h.clock.now.getTime() + 200_000);
  await run(h, cmd("analizar", [{ name: "texto", value: texto }], "u2")); // tope diario (2)
  assert.equal(h.llm.calls.length, 2);
});

test("/calendario, /sesgo y /resumen responden sin romper", async () => {
  const h = makeHarness({ calendar });
  await runCalendarJob(h.deps);
  for (const c of ["calendario", "sesgo", "resumen"]) {
    const { edits } = await run(h, cmd(c));
    assert.equal(edits.length, 1, c);
    assert.ok(!JSON.stringify(edits[0]).includes("Algo ha fallado"), c);
  }
});
