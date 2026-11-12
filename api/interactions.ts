import { waitUntil } from "@vercel/functions";
import { env } from "../lib/config.js";
import { handleInteraction } from "../lib/commands.js";
import { buildDeps } from "../lib/deps.js";
import { verifyDiscordSignature, type Interaction } from "../lib/discord.js";
import { json } from "../lib/http.js";

/** Comprobación rápida desde el navegador. */
export async function GET(): Promise<Response> {
  return new Response("Endpoint de comandos del bot de noticias: funcionando.", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Discord envía aquí los comandos (/estado, /resumen...). Cada petición va firmada. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  const valid = verifyDiscordSignature(
    body,
    request.headers.get("x-signature-ed25519"),
    request.headers.get("x-signature-timestamp"),
    env("DISCORD_PUBLIC_KEY")
  );
  if (!valid) return new Response("Firma no válida", { status: 401 });

  let interaction: Interaction;
  try {
    interaction = JSON.parse(body) as Interaction;
  } catch {
    return new Response("JSON no válido", { status: 400 });
  }

  // El "ping" de verificación de Discord no necesita base de datos
  if (interaction.type === 1) return json({ type: 1 });

  const deps = buildDeps();
  const result = await handleInteraction(interaction, deps, (p) => waitUntil(p));
  return json(result.body, result.status);
}
