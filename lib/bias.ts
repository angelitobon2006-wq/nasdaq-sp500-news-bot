import type { Confidence, Direction, Impact, MarketBias, NewsRow } from "./types.js";

const IMPACT_WEIGHT: Record<Impact, number> = { ALTO: 3, MEDIO: 2, BAJO: 1 };
const CONFIDENCE_WEIGHT: Record<Confidence, number> = { ALTA: 1, MEDIA: 0.7, BAJA: 0.4 };
const DIRECTION_SIGN: Record<MarketBias, number> = {
  ALCISTA: 1,
  BAJISTA: -1,
  NEUTRAL: 0,
  MIXTO: 0,
  NO_AFECTA: 0,
};

export interface MarketBiasResult {
  label: Direction;
  score: number;
  up: number;
  down: number;
  count: number;
}

export interface BiasResult {
  nasdaq: MarketBiasResult;
  sp500: MarketBiasResult;
  analyzed: number;
}

const THRESHOLD = 1.5;

function label(up: number, down: number, score: number, count: number): Direction {
  if (count === 0) return "NEUTRAL";
  if (up >= THRESHOLD && down >= THRESHOLD) return "MIXTO";
  if (score >= THRESHOLD) return "ALCISTA";
  if (score <= -THRESHOLD) return "BAJISTA";
  return "NEUTRAL";
}

/**
 * Sesgo fundamental calculado SIN llamar a Claude (coste cero):
 * suma el sentido de cada análisis reciente ponderado por impacto y confianza.
 * Es un resumen de lo publicado, no una señal de entrada.
 */
export function computeBias(rows: NewsRow[]): BiasResult {
  const acc = {
    nasdaq: { up: 0, down: 0, count: 0 },
    sp500: { up: 0, down: 0, count: 0 },
  };
  let analyzed = 0;

  for (const r of rows) {
    const a = r.analysis;
    if (!a || !a.relevante) continue;
    analyzed++;
    const w = IMPACT_WEIGHT[a.impacto] * CONFIDENCE_WEIGHT[a.confianza];
    for (const [key, bias] of [
      ["nasdaq", a.sesgo_nasdaq],
      ["sp500", a.sesgo_sp500],
    ] as const) {
      const sign = DIRECTION_SIGN[bias];
      if (bias !== "NO_AFECTA") acc[key].count++;
      if (sign > 0) acc[key].up += w;
      if (sign < 0) acc[key].down += w;
    }
  }

  const build = (k: "nasdaq" | "sp500"): MarketBiasResult => {
    const { up, down, count } = acc[k];
    const score = Math.round((up - down) * 100) / 100;
    return { label: label(up, down, score, count), score, up, down, count };
  };

  return { nasdaq: build("nasdaq"), sp500: build("sp500"), analyzed };
}
