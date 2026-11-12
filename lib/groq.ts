import type { Llm, LlmRequest, LlmResult } from "./anthropic.js";
import { fetchWithTimeout, sleep } from "./util.js";

/**
 * Cliente mínimo de Groq (plan gratuito, API compatible con OpenAI). Solo fetch, sin SDK.
 * Los límites gratuitos son por modelo y pueden cambiar: se controlan con los topes
 * diarios del bot y, si Groq responde 429, se espera y se reintenta una vez más.
 */
export function createGroq(apiKey: string, model: string, f: typeof fetch = fetch): Llm {
  return {
    async complete(req: LlmRequest): Promise<LlmResult> {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetchWithTimeout(
          f,
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model,
              max_completion_tokens: req.maxTokens,
              messages: [
                { role: "system", content: req.system },
                { role: "user", content: req.user },
              ],
            }),
          },
          35_000
        );

        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          const wait = Math.min(15, Number(res.headers.get("retry-after")) || 4);
          await sleep(wait * 1000);
          continue;
        }
        if (!res.ok) {
          throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          model?: string;
        };
        return {
          text: data.choices?.[0]?.message?.content ?? "",
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          model: data.model ?? model,
        };
      }
      throw new Error("Groq: demasiados reintentos");
    },
  };
}
