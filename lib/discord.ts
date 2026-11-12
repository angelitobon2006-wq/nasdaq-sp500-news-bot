import crypto from "node:crypto";
import type { Embed } from "./types.js";
import { fetchWithTimeout, sleep } from "./util.js";

const API = "https://discord.com/api/v10";

export interface MessagePayload {
  content?: string;
  embeds?: Embed[];
}

export interface DiscordPoster {
  /** Publica un mensaje en un canal y devuelve su ID. */
  postMessage(channelId: string, payload: MessagePayload): Promise<string>;
}

/**
 * Cliente de Discord que SOLO sabe publicar mensajes en un canal.
 * No gestiona roles, canales ni comandos de otras aplicaciones.
 */
export function createDiscord(botToken: string, f: typeof fetch = fetch): DiscordPoster {
  return {
    async postMessage(channelId, payload) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetchWithTimeout(
          f,
          `${API}/channels/${channelId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bot ${botToken}`,
              "Content-Type": "application/json",
              "User-Agent": "DiscordBot (nasdaq-sp500-news-bot, 1.0)",
            },
            body: JSON.stringify({
              ...payload,
              allowed_mentions: { parse: [] }, // nunca menciona a nadie
            }),
          },
          15_000
        );
        if (res.status === 429 && attempt < 2) {
          const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
          await sleep(Math.min(5, (data.retry_after ?? 1) + 0.2) * 1000);
          continue;
        }
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          throw new Error(`Discord ${res.status}: ${body}`);
        }
        const msg = (await res.json()) as { id: string };
        return msg.id;
      }
      throw new Error("Discord: demasiados reintentos por límite de peticiones");
    },
  };
}

/** Responde (editando el mensaje diferido) a un comando. No necesita token de bot. */
export async function editOriginalResponse(
  applicationId: string,
  interactionToken: string,
  payload: MessagePayload,
  f: typeof fetch = fetch
): Promise<void> {
  const res = await fetchWithTimeout(
    f,
    `${API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
    },
    10_000
  );
  if (!res.ok) {
    throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Comprueba que la petición viene realmente de Discord (firma Ed25519). */
export function verifyDiscordSignature(
  body: string,
  signatureHex: string | null,
  timestamp: string | null,
  publicKeyHex: string | undefined
): boolean {
  if (!signatureHex || !timestamp || !publicKeyHex) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKeyHex.trim().replace(/^"|"$/g, ""), "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(timestamp + body),
      key,
      Buffer.from(signatureHex, "hex")
    );
  } catch {
    return false;
  }
}

export interface Interaction {
  type: number;
  id?: string;
  application_id: string;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: {
    name?: string;
    options?: Array<{ name: string; type?: number; value?: string | number | boolean }>;
  };
}
