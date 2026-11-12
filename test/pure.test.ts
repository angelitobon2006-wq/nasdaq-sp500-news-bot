import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseFeed } from "../lib/rss.js";
import { scoreItem } from "../lib/relevance.js";
import { isNearDuplicate, titleTokens } from "../lib/dedupe.js";
import { parseAnalysis, parseSummary } from "../lib/analysis.js";
import { categorize, parseCalendar, groupSimultaneous } from "../lib/calendar.js";
import { formatMadrid, tzOffsetMinutes } from "../lib/util.js";
import { newsEmbed, calendarEmbed, fitEmbed } from "../lib/format.js";
import { verifyDiscordSignature } from "../lib/discord.js";
import { analysisJson } from "./helpers.js";

test("RSS 2.0 con CDATA y entidades", () => {
  const xml = `<rss><channel><item><title><![CDATA[Fed &amp; tipos]]></title><link>https://a.com/x</link>
  <description>&lt;p&gt;Hola&lt;/p&gt;</description><pubDate>Wed, 04 Nov 2026 14:00:00 GMT</pubDate></item></channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Fed & tipos");
  assert.equal(items[0].link, "https://a.com/x");
  assert.ok(!items[0].summary.includes("<p>"));
});

test("Atom con link href", () => {
  const xml = `<feed><entry><title>Hola</title><link href="https://b.com/y"/><updated>2026-11-04T14:00:00Z</updated><summary>s</summary></entry></feed>`;
  const items = parseFeed(xml);
  assert.equal(items[0].link, "https://b.com/y");
});

test("relevancia: Fed puntúa y deportes no", () => {
  assert.ok(scoreItem("Fed holds interest rates steady as inflation cools", "").score >= 3);
  assert.ok(scoreItem("Nvidia earnings beat as AI chip demand surges", "").score >= 3);
  assert.ok(scoreItem("Celebrity wedding photos released", "").score < 3);
});

test("casi duplicados por titular", () => {
  const a = titleTokens("Fed holds interest rates steady as inflation cools - Reuters");
  const b = titleTokens("Fed holds interest rates steady as inflation cools - CNBC");
  assert.ok(isNearDuplicate(b, [a]));
  assert.ok(!isNearDuplicate(titleTokens("Nvidia reports record data center revenue today"), [a]));
});

test("parseAnalysis: válido, con vallas de código y basura", () => {
  const ok = parseAnalysis(analysisJson());
  assert.equal(ok.impacto, "ALTO");
  assert.ok(ok.escenario_alcista);
  const fenced = parseAnalysis("```json\n" + analysisJson() + "\n```");
  assert.equal(fenced.impacto, "ALTO");
  assert.throws(() => parseAnalysis("no es json"));
  assert.throws(() => parseAnalysis(JSON.stringify({ impacto: "ENORME" })));
});

test("BAJO impacto fuerza escenarios nulos (sin operaciones)", () => {
  const a = parseAnalysis(analysisJson({ impacto: "BAJO" }));
  assert.equal(a.escenario_alcista, null);
  assert.equal(a.escenario_bajista, null);
});

test("parseSummary: tolera campos ausentes y rechaza texto no JSON", () => {
  const s = parseSummary("{}");
  assert.equal(s.sesgo_nasdaq, "NEUTRAL");
  assert.deepEqual(s.noticias_importantes, []);
  assert.throws(() => parseSummary("esto no es json"));
});

test("calendario: categorías y filtro USD", () => {
  assert.equal(categorize("Core CPI m/m").category, "CPI");
  assert.equal(categorize("Non-Farm Employment Change").category, "NFP");
  const ev = parseCalendar([
    { title: "CPI y/y", country: "USD", date: "2026-11-10T08:30:00-05:00", impact: "High", forecast: "3.1%", previous: "3.2%", actual: "" },
    { title: "CPI y/y", country: "EUR", date: "2026-11-10T08:30:00-05:00", impact: "High" },
    { title: "Algo menor", country: "USD", date: "2026-11-10T09:00:00-05:00", impact: "Low" },
    { title: "Raro", country: "USD", date: "fecha-mala", impact: "High" },
  ]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].impact, "ALTO");
  assert.equal(ev[0].actual, null); // nunca se inventa el dato publicado
  assert.equal(parseCalendar("basura").length, 0);
});

test("horario Madrid con cambios de verano/invierno", () => {
  // 08:30 Nueva York
  assert.equal(formatMadrid(new Date("2026-11-04T08:30:00-05:00"), "time"), "14:30"); // ambos en invierno
  assert.equal(formatMadrid(new Date("2026-10-28T08:30:00-04:00"), "time"), "13:30"); // EE.UU. aún en verano, Madrid ya en invierno
  assert.equal(formatMadrid(new Date("2026-03-10T08:30:00-04:00"), "time"), "13:30"); // EE.UU. verano, Madrid invierno
  assert.equal(formatMadrid(new Date("2026-03-31T08:30:00-04:00"), "time"), "14:30"); // ambos en verano
  assert.equal(tzOffsetMinutes(new Date("2026-07-01T12:00:00Z")), 120);
  assert.equal(tzOffsetMinutes(new Date("2026-01-01T12:00:00Z")), 60);
});

test("eventos simultáneos se agrupan", () => {
  const base = { category: "CPI", country: "USD", impact: "ALTO" as const, forecast: null, previous: null, actual: null, alert_sent: false };
  const g = groupSimultaneous([
    { ...base, id: "1", title: "CPI m/m", event_time: "2026-11-10T13:30:00.000Z" },
    { ...base, id: "2", title: "Core CPI m/m", event_time: "2026-11-10T13:30:00.000Z" },
    { ...base, id: "3", title: "NFP", event_time: "2026-11-11T13:30:00.000Z" },
  ]);
  assert.equal(g.length, 2);
});

test("embeds respetan los límites de Discord", () => {
  const long = "x".repeat(5000);
  const e = fitEmbed({ title: long, description: long, fields: Array.from({ length: 30 }, (_, i) => ({ name: "n" + i, value: long })) });
  assert.ok((e.title ?? "").length <= 256);
  assert.ok((e.description ?? "").length <= 4096);
  assert.ok((e.fields ?? []).length <= 25);
  const total = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(total < 6000);
  const full = newsEmbed(parseAnalysis(analysisJson()), { url: "https://x.com", source: "CNBC", publishedAt: "2026-11-04T14:00:00Z" } as never);
  assert.ok(full.fields!.length > 3);
  const low = newsEmbed(parseAnalysis(analysisJson({ impacto: "BAJO" })), { url: "https://x.com", source: "CNBC", publishedAt: "2026-11-04T14:00:00Z" } as never);
  assert.ok(low.fields!.length < full.fields!.length);
  assert.ok(calendarEmbed([], 3).description || calendarEmbed([], 3).title);
});

test("firma Ed25519 de Discord", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const pubHex = der.subarray(der.length - 32).toString("hex");
  const ts = "1700000000";
  const body = '{"type":1}';
  const sig = crypto.sign(null, Buffer.from(ts + body), privateKey).toString("hex");
  assert.equal(verifyDiscordSignature(body, sig, ts, pubHex), true);
  assert.equal(verifyDiscordSignature(body + " ", sig, ts, pubHex), false);
  assert.equal(verifyDiscordSignature(body, sig, ts, undefined), false);
  assert.equal(verifyDiscordSignature(body, "zz", ts, pubHex), false);
});

test("cliente Groq: formato OpenAI, reintento en 429 y lectura de tokens", async () => {
  const { createGroq } = await import("../lib/groq.js");
  let n = 0;
  const f = (async (_u: unknown, init: { body: string; headers: Record<string, string> }) => {
    n++;
    if (n === 1) return new Response("limite", { status: 429, headers: { "retry-after": "0" } });
    const b = JSON.parse(init.body);
    assert.equal(b.messages[0].role, "system");
    assert.equal(init.headers.authorization, "Bearer k");
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "m" }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await createGroq("k", "m", f).complete({ system: "s", user: "u", maxTokens: 50 });
  assert.equal(r.text, "{}");
  assert.equal(r.inputTokens, 10);
  assert.equal(n, 2);
});
