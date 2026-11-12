import { env } from "../lib/config.js";
import { json } from "../lib/http.js";

const NAMES = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_CHANNEL_ID",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_GUILD_ID",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
];

/** Dice qué variables están configuradas (solo sí/no, nunca los valores). */
export async function GET(): Promise<Response> {
  const configured: Record<string, boolean> = {};
  for (const n of NAMES) configured[n] = env(n) !== undefined;
  const anthropic = env("LLM_PROVIDER")?.toLowerCase() === "anthropic";
  const llmKey = anthropic ? "ANTHROPIC_API_KEY" : "GROQ_API_KEY";
  configured[llmKey] = env(llmKey) !== undefined;
  const cron = env("CRON_SECRET");
  return json({
    ok: Object.values(configured).every(Boolean),
    time: new Date().toISOString(),
    configured,
    avisos: cron && cron.length < 16 ? ["CRON_SECRET es demasiado corta (mínimo 16 caracteres)"] : [],
  });
}
