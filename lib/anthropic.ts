import { fetchWithTimeout, sleep } from "./util.js";

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface Llm {
  complete(req: LlmRequest): Promise<LlmResult>;
}

/** Cliente mínimo de la API de Anthropic (sin SDK, solo fetch). */
export function createClaude(
  apiKey: string,
  model: string,
  f: typeof fetch = fetch
): Llm {
  return {
    async complete(req: LlmRequest): Promise<LlmResult> {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetchWithTimeout(
          f,
          "https://api.anthropic.com/v1/messages",
          {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              max_tokens: req.maxTokens,
              system: req.system,
              messages: [{ role: "user", content: req.user }],
            }),
          },
          35_000
        );

        if ((res.status === 429 || res.status === 529) && attempt === 0) {
          const wait = Math.min(5, Number(res.headers.get("retry-after")) || 2);
          await sleep(wait * 1000);
          continue;
        }
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          throw new Error(`Anthropic ${res.status}: ${body}`);
        }

        const data = (await res.json()) as {
          content?: Array<{ type: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
          model?: string;
        };
        const text = (data.content ?? [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("");
        return {
          text,
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
          model: data.model ?? model,
        };
      }
      throw new Error("Anthropic: demasiados reintentos");
    },
  };
}
